import {
  SEEN_DB_NAME,
  SEEN_LIST_LIMIT,
  SEEN_STORE,
  type SeenRecord,
} from '#/features/cloudless/seen/constants'
import {
  createIndexedDbStorage,
  type SeenStorage,
} from '#/features/cloudless/seen/db'
import {
  type SeenListDeps,
  SeenListRegistry,
} from '#/features/cloudless/seen/seenList'
import {
  createFakeIndexedDbGlobals,
  FakeIndexedDb,
} from '#/features/cloudless/seen/testing/fakeIndexedDb'
import {SeenSyncer, type SeenSyncerDeps, withoutLock} from '../SeenSyncer'
import {FakeSyncService} from '../testing/fakeSyncService'

jest.mock('#/logger', () => ({
  logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn()},
}))

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

function uri(n: number | string) {
  return `at://did:plc:author/app.bsky.feed.post/${n}`
}

function wait(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function until(condition: () => boolean, timeoutMs = 2_000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for a condition')
    }
    await wait(2)
  }
}

let clock = 1_000_000

function storageFor(fake: FakeIndexedDb): SeenStorage {
  return createIndexedDbStorage(createFakeIndexedDbGlobals(fake).globals)
}

function listDeps(
  fake: FakeIndexedDb | null,
  overrides: Partial<SeenListDeps> = {},
): SeenListDeps {
  return {
    storage: fake ? storageFor(fake) : null,
    channel: null,
    now: () => clock,
    limit: SEEN_LIST_LIMIT,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
    ...overrides,
  }
}

function records(fake: FakeIndexedDb, did = ALICE) {
  return Object.fromEntries(
    (fake.dump(SEEN_DB_NAME, SEEN_STORE) as SeenRecord[])
      .filter(r => r.did === did)
      .map(r => [r.uri, {seenAt: r.seenAt, dirty: r.dirty}]),
  )
}

type Logged = {message: string; data?: Record<string, unknown>}

/**
 * A device: its own IndexedDB, seen lists and syncer for `did`.
 */
function createDevice(
  service: FakeSyncService,
  {
    did = ALICE,
    fake = new FakeIndexedDb(),
    memoryOnly = false,
    syncer: syncerOverrides = {},
  }: {
    did?: string
    fake?: FakeIndexedDb
    memoryOnly?: boolean
    syncer?: Partial<SeenSyncerDeps>
  } = {},
) {
  const lists = new SeenListRegistry(listDeps(memoryOnly ? null : fake))
  const list = lists.get(did)
  const logs: Logged[] = []
  let visible = true
  const syncer = new SeenSyncer(list, {
    client: service.client(),
    isVisible: () => visible,
    withLock: withoutLock,
    log: (message, data) => logs.push({message, data}),
    intervalMs: 60_000,
    pushDelayMs: 10,
    retryBaseMs: 20,
    retryMaxMs: 80,
    ...syncerOverrides,
  })
  const count = (message: string) =>
    logs.filter(l => l.message === message).length
  return {
    fake,
    lists,
    list,
    syncer,
    logs,
    count,
    setVisible(value: boolean) {
      visible = value
    },
    /**
     * Waits for the next sync to finish, successfully or not.
     */
    async nextSync() {
      const before = count('synced') + count('sync failed')
      await until(() => count('synced') + count('sync failed') > before)
    },
  }
}

const devices: ReturnType<typeof createDevice>[] = []

function device(...args: Parameters<typeof createDevice>) {
  const d = createDevice(...args)
  devices.push(d)
  return d
}

beforeEach(() => {
  clock = 1_000_000
})

afterEach(() => {
  for (const d of devices.splice(0)) d.syncer.stop()
})

describe('SeenSyncer', () => {
  it('uploads posts seen before sync existed, and pages through a first sync', async () => {
    const service = new FakeSyncService({pageSize: 2})
    for (let i = 0; i < 5; i++) {
      service.write(ALICE, [{uri: uri(`remote${i}`), seenAt: 100 + i}])
    }
    const fake = new FakeIndexedDb()
    // Story 2.2 records: written before sync, so still dirty.
    await storageFor(fake).write(ALICE, [
      {uri: uri('local1'), seenAt: 50},
      {uri: uri('local2'), seenAt: 60},
    ])

    const d = device(service, {fake})
    d.syncer.start()
    await d.nextSync()

    const pulls = service.requests.filter(r => r.type === 'pull')
    expect(pulls).toHaveLength(3)
    expect(pulls[0]).toMatchObject({since: undefined, cursor: undefined})
    expect(pulls[1].type === 'pull' && pulls[1].cursor).toBeTruthy()

    expect(service.entries(ALICE)).toMatchObject({
      [uri('local1')]: 50,
      [uri('local2')]: 60,
    })
    const local = records(fake)
    expect(Object.keys(local)).toHaveLength(7)
    expect(Object.values(local).every(r => r.dirty === 0)).toBe(true)
    for (let i = 0; i < 5; i++) {
      expect(d.list.get(uri(`remote${i}`))?.seenAt).toBe(100 + i)
    }
    expect(await d.list.getSyncTime()).toBe(service.clock - 1)
  })

  it('pulls only changes since the last complete pull', async () => {
    const service = new FakeSyncService()
    service.write(ALICE, [{uri: uri(1), seenAt: 1}])
    const d = device(service)
    d.syncer.start()
    await d.nextSync()
    const position = await d.list.getSyncTime()

    service.write(ALICE, [{uri: uri(2), seenAt: 2}])
    await d.syncer.sync({pull: true})
    const last = service.requests.filter(r => r.type === 'pull').at(-1)
    expect(last).toMatchObject({since: position})
    expect(d.list.get(uri(2))?.seenAt).toBe(2)
  })

  it('moves the position only after the last page is merged', async () => {
    const service = new FakeSyncService({pageSize: 1})
    service.write(ALICE, [{uri: uri(1), seenAt: 1}])
    service.write(ALICE, [{uri: uri(2), seenAt: 2}])
    let pulls = 0
    service.onRequest = req => {
      if (req.type === 'pull' && ++pulls === 2) {
        throw new TypeError('Failed to fetch')
      }
    }
    const d = device(service)
    d.syncer.start()
    await d.nextSync()
    expect(d.count('sync failed')).toBe(1)
    expect(await d.list.getSyncTime()).toBeUndefined()
    // The first page is merged already; merging it again is harmless.
    expect(d.list.get(uri(1))).toBeDefined()

    await d.nextSync()
    expect(d.count('synced')).toBe(1)
    expect(d.list.get(uri(2))).toBeDefined()
    expect(await d.list.getSyncTime()).toBe(service.clock)
  })

  it('merges with the later time and keeps the unsynced marker on a newer local entry', async () => {
    const service = new FakeSyncService()
    service.write(ALICE, [
      {uri: uri(1), seenAt: 300},
      {uri: uri(2), seenAt: 900},
    ])
    const fake = new FakeIndexedDb()
    await storageFor(fake).write(ALICE, [
      {uri: uri(1), seenAt: 500},
      {uri: uri(2), seenAt: 600},
    ])
    let atPush: ReturnType<typeof records> | undefined
    service.onRequest = req => {
      if (req.type === 'push') atPush = records(fake)
    }
    const d = device(service, {fake})
    d.syncer.start()
    await d.nextSync()

    // After the pull: uri(1) kept its later local time and stayed dirty.
    expect(atPush).toEqual({
      [uri(1)]: {seenAt: 500, dirty: 1},
      [uri(2)]: {seenAt: 900, dirty: 0},
    })
    const push = service.requests.find(r => r.type === 'push')
    expect(push?.type === 'push' && push.entries).toEqual([
      {uri: uri(1), seenAt: 500},
    ])
    expect(service.entries(ALICE)).toEqual({[uri(1)]: 500, [uri(2)]: 900})
    expect(records(fake)[uri(1)]).toEqual({seenAt: 500, dirty: 0})
  })

  it('keeps an entry unsynced when it is seen again during the push', async () => {
    const service = new FakeSyncService()
    const d = device(service)
    await d.list.ready
    d.list.add([uri(1)], 100)
    let once = false
    service.onRequest = req => {
      if (req.type === 'push' && !once) {
        once = true
        d.list.add([uri(1)], 200)
      }
    }
    await d.syncer.sync({pull: false})
    expect(service.entries(ALICE)).toEqual({[uri(1)]: 100})
    await d.list.flush()
    expect(records(d.fake)[uri(1)]).toEqual({seenAt: 200, dirty: 1})

    await d.syncer.sync({pull: false})
    expect(service.entries(ALICE)).toEqual({[uri(1)]: 200})
    expect(records(d.fake)[uri(1)]).toEqual({seenAt: 200, dirty: 0})
  })

  it('pushes shortly after posts are seen, without pulling', async () => {
    const service = new FakeSyncService()
    const d = device(service)
    d.syncer.start()
    await d.nextSync()
    const before = service.requests.length

    d.list.add([uri(1), uri(2)], 100)
    d.list.add([uri(3)], 101)
    await until(() => service.entries(ALICE)[uri(3)] === 101)
    const after = service.requests.slice(before)
    expect(after.map(r => r.type)).toEqual(['push'])
  })

  it('retries with growing delays while the service is unreachable, and loses nothing', async () => {
    const service = new FakeSyncService()
    service.offline = true
    const d = device(service)
    d.syncer.start()
    await d.list.ready
    d.list.add([uri(1)], 100)
    await until(() => d.count('sync failed') >= 4)
    const delays = d.logs
      .filter(l => l.message === 'sync failed')
      .map(l => l.data?.retryInMs)
    expect(delays.slice(0, 4)).toEqual([20, 40, 80, 80])

    d.list.add([uri(2)], 200)
    service.offline = false
    await until(() => d.count('synced') === 1)
    expect(service.entries(ALICE)).toEqual({[uri(1)]: 100, [uri(2)]: 200})
    expect(records(d.fake)).toEqual({
      [uri(1)]: {seenAt: 100, dirty: 0},
      [uri(2)]: {seenAt: 200, dirty: 0},
    })
  })

  it('waits while hidden and syncs as soon as it is visible again', async () => {
    const service = new FakeSyncService()
    service.offline = true
    const d = device(service)
    d.setVisible(false)
    d.syncer.start()
    await d.nextSync()
    const requests = service.requests.length
    await wait(100)
    // The retry came due while hidden and did nothing.
    expect(service.requests.length).toBe(requests)

    service.offline = false
    d.setVisible(true)
    d.syncer.resume()
    await d.nextSync()
    expect(d.count('synced')).toBe(1)
  })

  it('syncs only its own account', async () => {
    const service = new FakeSyncService()
    service.write(ALICE, [{uri: uri('a'), seenAt: 1}])
    service.write(BOB, [{uri: uri('b'), seenAt: 2}])
    const fake = new FakeIndexedDb()
    const storage = storageFor(fake)
    await storage.write(ALICE, [{uri: uri('alice-local'), seenAt: 3}])
    await storage.write(BOB, [{uri: uri('bob-local'), seenAt: 4}])

    const d = device(service, {did: ALICE, fake})
    d.syncer.start()
    await d.nextSync()

    expect(service.requests.every(r => r.did === ALICE)).toBe(true)
    expect(service.entries(ALICE)).toEqual({
      [uri('a')]: 1,
      [uri('alice-local')]: 3,
    })
    expect(service.entries(BOB)).toEqual({[uri('b')]: 2})
    expect(d.list.get(uri('b'))).toBeUndefined()
    expect(records(fake, BOB)).toEqual({
      [uri('bob-local')]: {seenAt: 4, dirty: 1},
    })
    expect(await storage.readMeta(BOB)).toBeUndefined()
  })

  it('stops its timers and requests when stopped', async () => {
    const service = new FakeSyncService()
    let release: () => void = () => {}
    service.onRequest = req =>
      req.type === 'pull'
        ? new Promise<void>(resolve => {
            release = resolve
          })
        : undefined
    service.write(ALICE, [{uri: uri(1), seenAt: 1}])
    const d = device(service, {syncer: {intervalMs: 10}})
    d.syncer.start()
    await until(() => service.requests.length === 1)

    d.syncer.stop()
    release()
    d.list.add([uri(2)], 2)
    await wait(100)
    expect(service.requests).toHaveLength(1)
    expect(d.list.get(uri(1))).toBeUndefined()
    expect(await d.list.getSyncTime()).toBeUndefined()
    expect(d.count('synced') + d.count('sync failed')).toBe(0)
  })

  it('syncs every interval while visible', async () => {
    const service = new FakeSyncService()
    const d = device(service, {syncer: {intervalMs: 20}})
    d.syncer.start()
    await until(() => d.count('synced') >= 3)
    d.setVisible(false)
    await wait(50)
    const pulls = service.requests.filter(r => r.type === 'pull').length
    await wait(80)
    expect(service.requests.filter(r => r.type === 'pull')).toHaveLength(pulls)
  })

  it('keeps pulling every interval while the user keeps seeing posts', async () => {
    const service = new FakeSyncService()
    const d = device(service, {syncer: {intervalMs: 50, pushDelayMs: 10}})
    d.syncer.start()
    await d.list.ready
    // A sighting every 12 ms schedules a push every 10 ms or so.
    for (let i = 0; i < 30; i++) {
      d.list.add([uri(i)], i + 1)
      await wait(12)
    }
    const pulls = service.requests.filter(r => r.type === 'pull')
    expect(pulls.length).toBeGreaterThanOrEqual(4)
  })

  it('starts over when the service rejects the saved position', async () => {
    const service = new FakeSyncService()
    service.write(ALICE, [{uri: uri(1), seenAt: 1}])
    const d = device(service)
    await d.list.ready
    await d.list.setSyncTime(Number.MAX_SAFE_INTEGER)
    await d.syncer.sync({pull: true})
    expect(d.count('synced')).toBe(1)
    expect(d.list.get(uri(1))).toBeDefined()
    expect(await d.list.getSyncTime()).toBe(service.clock)
  })

  it('sends one keepalive batch under 64 KB when the page is hidden', async () => {
    const service = new FakeSyncService()
    const d = device(service, {syncer: {pushDelayMs: 60_000}})
    await d.list.ready
    const uris = Array.from({length: 2_000}, (_, i) => uri(`p${i}`))
    d.list.add(uris, 100)
    d.list.add([uri('newest')], 200)

    d.syncer.pushOnHide()
    d.syncer.pushOnHide()
    await until(() => d.count('pushed on hide') === 1)
    const sent = service.requests.filter(r => r.type === 'keepalive')
    expect(sent).toHaveLength(1)
    const body = JSON.stringify({
      did: ALICE,
      entries: sent[0].type === 'keepalive' ? sent[0].entries : [],
    })
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(60_000)
    const entries = sent[0].type === 'keepalive' ? sent[0].entries : []
    expect(entries[0]).toEqual({uri: uri('newest'), seenAt: 200})
    expect(entries.length).toBeGreaterThan(100)
    expect(entries.length).toBeLessThan(1_000)
    // What was sent leaves the queue; the rest goes next time.
    expect(d.list.peekUnsynced()).toHaveLength(2_001 - entries.length)
  })

  it('syncs in memory when IndexedDB is unavailable', async () => {
    const service = new FakeSyncService()
    service.write(ALICE, [{uri: uri('remote'), seenAt: 1}])
    const d = device(service, {memoryOnly: true})
    d.syncer.start()
    await d.nextSync()
    expect(d.list.isPersistent).toBe(false)
    expect(d.list.get(uri('remote'))).toBeDefined()

    d.list.add([uri('local')], 5)
    await until(() => service.entries(ALICE)[uri('local')] === 5)
    expect(d.list.peekUnsynced()).toEqual([])
  })

  it('shares posts between devices without changing what is on screen', async () => {
    const service = new FakeSyncService()
    const phone = device(service)
    const laptop = device(service)
    phone.syncer.start()
    laptop.syncer.start()
    await Promise.all([phone.nextSync(), laptop.nextSync()])

    // The laptop's feed is on screen as of this moment.
    const laptopSnapshot = clock
    clock += 1_000
    phone.list.add([uri('read-on-phone')], clock)
    await until(() => service.entries(ALICE)[uri('read-on-phone')] === clock)

    clock += 1_000
    await laptop.syncer.sync({pull: true})
    expect(laptop.list.get(uri('read-on-phone'))).toEqual({
      seenAt: clock - 1_000,
      knownAt: clock,
    })
    // Hidden from the next refresh on, not while scrolling.
    expect(laptop.list.isSeenAsOf(uri('read-on-phone'), laptopSnapshot)).toBe(
      false,
    )
    expect(laptop.list.isSeenAsOf(uri('read-on-phone'), clock)).toBe(true)
  })
})
