import {
  SEEN_DB_NAME,
  SEEN_LIST_LIMIT,
  SEEN_STORE,
  type SeenRecord,
} from '#/features/cloudless/seen/constants'
import {
  createIndexedDbStorage,
  type SeenEntry,
} from '#/features/cloudless/seen/db'
import {
  type SeenChannel,
  type SeenListDeps,
  SeenListRegistry,
} from '#/features/cloudless/seen/seenList'
import {
  createFakeIndexedDbGlobals,
  FakeIndexedDb,
} from '#/features/cloudless/seen/testing/fakeIndexedDb'

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

function records(fake: FakeIndexedDb, did = ALICE) {
  return Object.fromEntries(
    (fake.dump(SEEN_DB_NAME, SEEN_STORE) as SeenRecord[])
      .filter(r => r.did === did)
      .map(r => [r.uri, {seenAt: r.seenAt, dirty: r.dirty}]),
  )
}

let clock = 1_000_000

function deps(
  fake: FakeIndexedDb | null,
  overrides: Partial<SeenListDeps> = {},
): SeenListDeps {
  return {
    storage: fake
      ? createIndexedDbStorage(createFakeIndexedDbGlobals(fake).globals, {
          limit: overrides.limit ?? SEEN_LIST_LIMIT,
        })
      : null,
    channel: null,
    now: () => clock,
    limit: SEEN_LIST_LIMIT,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 1_000,
    ...overrides,
  }
}

beforeEach(() => {
  clock = 1_000_000
})

describe('IndexedDB sync helpers', () => {
  function storage(fake = new FakeIndexedDb()) {
    return {
      fake,
      storage: createIndexedDbStorage(createFakeIndexedDbGlobals(fake).globals),
    }
  }

  it('reads only the dirty records of one account, up to a limit', async () => {
    const {storage: s} = storage()
    await s.write(ALICE, [
      {uri: uri(1), seenAt: 1},
      {uri: uri(2), seenAt: 2},
      {uri: uri(3), seenAt: 3},
    ])
    await s.write(ALICE, [{uri: uri(4), seenAt: 4}], {dirty: 0})
    await s.write(BOB, [{uri: uri(5), seenAt: 5}])

    const dirty = await s.readDirty(ALICE, 10)
    expect(dirty.map(e => e.uri).sort()).toEqual([uri(1), uri(2), uri(3)])
    expect(await s.readDirty(ALICE, 2)).toHaveLength(2)
    expect(await s.readDirty(BOB, 10)).toEqual([{uri: uri(5), seenAt: 5}])
  })

  it('marks records synced only where seenAt is unchanged', async () => {
    const {fake, storage: s} = storage()
    await s.write(ALICE, [
      {uri: uri(1), seenAt: 100},
      {uri: uri(2), seenAt: 100},
    ])
    const sent = await s.readDirty(ALICE, 10)
    // uri(2) is seen again while the batch is in flight.
    await s.write(ALICE, [{uri: uri(2), seenAt: 200}])
    await s.markSynced(ALICE, sent)

    expect(records(fake)).toEqual({
      [uri(1)]: {seenAt: 100, dirty: 0},
      [uri(2)]: {seenAt: 200, dirty: 1},
    })
  })

  it('keeps the sync position per account', async () => {
    const {fake, storage: s} = storage()
    expect(await s.readMeta(ALICE)).toBeUndefined()
    await s.writeMeta({did: ALICE, lastSyncServerTime: 42})
    await s.writeMeta({did: BOB, lastSyncServerTime: 7})

    // A new connection, as after reopening the app.
    const reopened = createIndexedDbStorage(
      createFakeIndexedDbGlobals(fake).globals,
    )
    expect(await reopened.readMeta(ALICE)).toEqual({
      did: ALICE,
      lastSyncServerTime: 42,
    })
    expect(await reopened.readMeta(BOB)).toEqual({
      did: BOB,
      lastSyncServerTime: 7,
    })
  })

  describe('writing pulled entries (dirty: 0)', () => {
    it('stores new and later entries as synced', async () => {
      const {fake, storage: s} = storage()
      await s.write(ALICE, [{uri: uri(1), seenAt: 100}])
      const result = await s.write(
        ALICE,
        [
          {uri: uri(1), seenAt: 300},
          {uri: uri(2), seenAt: 200},
        ],
        {dirty: 0},
      )
      expect(result.written).toEqual([
        {uri: uri(1), seenAt: 300},
        {uri: uri(2), seenAt: 200},
      ])
      expect(records(fake)).toEqual({
        [uri(1)]: {seenAt: 300, dirty: 0},
        [uri(2)]: {seenAt: 200, dirty: 0},
      })
    })

    it('keeps a later local entry and its unsynced marker', async () => {
      const {fake, storage: s} = storage()
      await s.write(ALICE, [{uri: uri(1), seenAt: 500}])
      const result = await s.write(ALICE, [{uri: uri(1), seenAt: 300}], {
        dirty: 0,
      })
      expect(result.written).toEqual([])
      expect(records(fake)).toEqual({[uri(1)]: {seenAt: 500, dirty: 1}})
    })

    it('marks a local entry with the same time as synced', async () => {
      const {fake, storage: s} = storage()
      await s.write(ALICE, [{uri: uri(1), seenAt: 500}])
      const result = await s.write(ALICE, [{uri: uri(1), seenAt: 500}], {
        dirty: 0,
      })
      expect(result.written).toEqual([])
      expect(records(fake)).toEqual({[uri(1)]: {seenAt: 500, dirty: 0}})
    })
  })
})

describe('SeenList sync support', () => {
  function createChannelBus() {
    const members = new Set<SeenChannel>()
    return () => {
      const channel: SeenChannel = {
        onmessage: null,
        postMessage(message) {
          for (const other of members) {
            if (other === channel) continue
            const data = structuredClone(message)
            setTimeout(() => other.onmessage?.({data}), 0)
          }
        },
        close() {
          members.delete(channel)
        },
      }
      members.add(channel)
      return channel
    }
  }

  it('merges pulled entries with the later time, known from now', async () => {
    const fake = new FakeIndexedDb()
    const lists = new SeenListRegistry(deps(fake))
    const list = lists.get(ALICE)
    await list.ready
    list.add([uri(1)], 500)
    await list.flush()

    const snapshot = clock
    clock += 1_000
    await list.applySynced([
      {uri: uri(1), seenAt: 300},
      {uri: uri(2), seenAt: 200},
      {uri: uri(3), seenAt: 900},
    ])

    expect(list.get(uri(1))).toEqual({seenAt: 500, knownAt: snapshot})
    expect(list.get(uri(2))).toEqual({seenAt: 200, knownAt: clock})
    // Learned after the snapshot, so nothing on screen changes.
    expect(list.isSeenAsOf(uri(2), snapshot)).toBe(false)
    expect(list.isSeenAsOf(uri(2), clock)).toBe(true)
    expect(list.oldestSeenAt(snapshot)).toBe(500)
    expect(list.oldestSeenAt(clock)).toBe(200)

    expect(records(fake)).toEqual({
      [uri(1)]: {seenAt: 500, dirty: 1},
      [uri(2)]: {seenAt: 200, dirty: 0},
      [uri(3)]: {seenAt: 900, dirty: 0},
    })
  })

  it('announces pulled entries to other tabs', async () => {
    const fake = new FakeIndexedDb()
    const bus = createChannelBus()
    const tabA = new SeenListRegistry(deps(fake, {channel: bus()}))
    const tabB = new SeenListRegistry(deps(fake, {channel: bus()}))
    const listA = tabA.get(ALICE)
    const listB = tabB.get(ALICE)
    await Promise.all([listA.ready, listB.ready])

    await listA.applySynced([{uri: uri(1), seenAt: 100}])
    await wait(5)
    expect(listB.get(uri(1))?.seenAt).toBe(100)
  })

  it('applies the rolling limit to pulled entries', async () => {
    const fake = new FakeIndexedDb()
    const lists = new SeenListRegistry(deps(fake, {limit: 3}))
    const list = lists.get(ALICE)
    await list.ready
    list.add([uri('a'), uri('b')], 50)
    await list.flush()
    await list.applySynced([
      {uri: uri('c'), seenAt: 10},
      {uri: uri('d'), seenAt: 60},
      {uri: uri('e'), seenAt: 70},
    ])
    // The oldest go first, ties in URI order, as on the service.
    const kept = [uri('b'), uri('d'), uri('e')]
    expect(Object.keys(records(fake)).sort()).toEqual(kept)
    expect(list.size).toBe(3)
    for (const u of kept) expect(list.get(u)).toBeDefined()
  })

  it('works in memory when there is no IndexedDB', async () => {
    const lists = new SeenListRegistry(deps(null, {limit: 2}))
    const list = lists.get(ALICE)
    await list.ready
    list.add([uri(1)], 100)

    expect(await list.readUnsynced(10)).toEqual([{uri: uri(1), seenAt: 100}])
    await list.markSynced([{uri: uri(1), seenAt: 100}])
    expect(await list.readUnsynced(10)).toEqual([])

    expect(await list.getSyncTime()).toBeUndefined()
    await list.setSyncTime(5)
    expect(await list.getSyncTime()).toBe(5)

    await list.applySynced([
      {uri: uri(2), seenAt: 200},
      {uri: uri(3), seenAt: 300},
    ])
    expect(list.size).toBe(2)
    expect(list.get(uri(1))).toBeUndefined()
    expect(list.get(uri(3))?.knownAt).toBe(clock)
  })

  it('includes pending sightings in what it reads to send', async () => {
    const fake = new FakeIndexedDb()
    const lists = new SeenListRegistry(deps(fake))
    const list = lists.get(ALICE)
    await list.ready
    list.add([uri(1)], 100)
    // Not flushed yet: the 60-second flush interval has not passed.
    expect(await list.readUnsynced(10)).toEqual([{uri: uri(1), seenAt: 100}])
  })

  it('lists recent unsynced sightings from memory, newest first', async () => {
    const lists = new SeenListRegistry(deps(new FakeIndexedDb()))
    const list = lists.get(ALICE)
    await list.ready
    list.add([uri(1)], 100)
    list.add([uri(2)], 200)
    expect(list.peekUnsynced()).toEqual<SeenEntry[]>([
      {uri: uri(2), seenAt: 200},
      {uri: uri(1), seenAt: 100},
    ])
    // A pulled entry at least as late means the service has it.
    await list.applySynced([{uri: uri(2), seenAt: 200}])
    expect(list.peekUnsynced()).toEqual([{uri: uri(1), seenAt: 100}])
  })
})
