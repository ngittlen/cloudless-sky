import {
  SEEN_DB_NAME,
  SEEN_LIST_LIMIT,
  SEEN_STORE,
  type SeenRecord,
} from '#/features/cloudless/seen/constants'
import {
  createIndexedDbStorage,
  openSeenDb,
  writeSeen,
} from '#/features/cloudless/seen/db'
import {
  type SeenChannel,
  type SeenListDeps,
  SeenListRegistry,
} from '#/features/cloudless/seen/seenList'
import {
  createFakeIndexedDbGlobals,
  type FakeIndexedDb,
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

/**
 * A BroadcastChannel stand-in shared by the "tabs" of one test.
 */
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

function storedRecords(fake: FakeIndexedDb, did?: string) {
  return (fake.dump(SEEN_DB_NAME, SEEN_STORE) as SeenRecord[]).filter(
    r => !did || r.did === did,
  )
}

describe('SeenList', () => {
  let fake: FakeIndexedDb

  beforeEach(() => {
    fake = createFakeIndexedDbGlobals().fake
    clock = 1_000_000
  })

  it('keeps the limit at 100,000', () => {
    expect(SEEN_LIST_LIMIT).toBe(100_000)
  })

  it('saves seen posts and loads them after reopening', async () => {
    const tab = new SeenListRegistry(deps(fake))
    const list = tab.get(ALICE)
    await list.ready
    list.add([uri(1), uri(2)], 500)
    await list.flush()

    clock = 2_000_000
    const reopened = new SeenListRegistry(deps(fake)).get(ALICE)
    await reopened.ready

    expect(reopened.size).toBe(2)
    expect(reopened.get(uri(1))).toEqual({seenAt: 500, knownAt: 2_000_000})
    expect(reopened.isPersistent).toBe(true)
  })

  it('writes pending posts after the flush interval', async () => {
    const list = new SeenListRegistry(deps(fake, {flushIntervalMs: 5})).get(
      ALICE,
    )
    await list.ready
    list.add([uri(1)], 500)
    expect(storedRecords(fake)).toHaveLength(0)

    await wait(30)

    expect(storedRecords(fake)).toHaveLength(1)
  })

  it('keeps the later seenAt for a post seen twice', async () => {
    const list = new SeenListRegistry(deps(fake)).get(ALICE)
    await list.ready
    list.add([uri(1)], 800)
    await list.flush()
    list.add([uri(1)], 500)
    await list.flush()

    expect(list.get(uri(1))?.seenAt).toBe(800)
    expect(storedRecords(fake).map(r => r.seenAt)).toEqual([800])
  })

  it('stamps knownAt with the time this device learned of the post', async () => {
    const list = new SeenListRegistry(deps(fake)).get(ALICE)
    await list.ready
    clock = 1_500_000
    list.add([uri(1)], 1_400_000)

    expect(list.isSeenAsOf(uri(1), 1_499_999)).toBe(false)
    expect(list.isSeenAsOf(uri(1), 1_500_000)).toBe(true)
  })

  describe('rolling limit', () => {
    it('drops the posts seen longest ago from storage and memory', async () => {
      const list = new SeenListRegistry(deps(fake, {limit: 3})).get(ALICE)
      await list.ready
      list.add([uri('a')], 100)
      list.add([uri('b')], 200)
      list.add([uri('c')], 300)
      await list.flush()
      list.add([uri('d')], 400)
      list.add([uri('e')], 500)
      await list.flush()

      expect(
        storedRecords(fake)
          .map(r => r.uri)
          .sort(),
      ).toEqual([uri('c'), uri('d'), uri('e')])
      expect(list.size).toBe(3)
      expect(list.get(uri('a'))).toBeUndefined()
      expect(list.get(uri('b'))).toBeUndefined()
    })

    it('holds exactly 100,000 posts once full', async () => {
      const {globals} = createFakeIndexedDbGlobals(fake)
      const db = await openSeenDb(globals)
      await writeSeen(db, globals, ALICE, [])
      const store = fake.databases.get(SEEN_DB_NAME)!.stores.get(SEEN_STORE)!
      for (let i = 0; i < SEEN_LIST_LIMIT; i++) {
        const value = {did: ALICE, uri: uri(i), seenAt: 1000 + i, dirty: 1}
        store.records.set(JSON.stringify([ALICE, uri(i)]), {
          key: [ALICE, uri(i)],
          value,
        })
      }

      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready
      expect(list.size).toBe(SEEN_LIST_LIMIT)
      list.add([uri('new')], 999_999)
      await list.flush()

      expect(list.size).toBe(SEEN_LIST_LIMIT)
      expect(store.records.size).toBe(SEEN_LIST_LIMIT)
      expect(list.get(uri(0))).toBeUndefined()
      expect(list.get(uri('new'))).toBeDefined()
      expect(list.oldestSeenAt(clock)).toBe(1001)
    })

    it('counts each account separately', async () => {
      const tab = new SeenListRegistry(deps(fake, {limit: 2}))
      const alice = tab.get(ALICE)
      await alice.ready
      alice.add([uri(1), uri(2)], 100)
      await alice.flush()
      const bob = tab.get(BOB)
      await bob.ready
      bob.add([uri(3), uri(4)], 200)
      await bob.flush()

      expect(storedRecords(fake, ALICE)).toHaveLength(2)
      expect(storedRecords(fake, BOB)).toHaveLength(2)
    })

    it('applies to a list held only in memory', async () => {
      const list = new SeenListRegistry(deps(null, {limit: 2})).get(ALICE)
      await list.ready
      list.add([uri('a')], 100)
      list.add([uri('b')], 200)
      list.add([uri('c')], 300)

      expect(list.size).toBe(2)
      expect(list.get(uri('a'))).toBeUndefined()
    })

    it('moves the look-back limit forward as old posts drop', async () => {
      const list = new SeenListRegistry(deps(fake, {limit: 2})).get(ALICE)
      await list.ready
      list.add([uri('a')], 100)
      list.add([uri('b')], 200)
      await list.flush()
      expect(list.oldestSeenAt(clock)).toBe(100)

      list.add([uri('c')], 300)
      await list.flush()
      expect(list.oldestSeenAt(clock)).toBe(200)
    })
  })

  it('keeps accounts apart', async () => {
    const tab = new SeenListRegistry(deps(fake))
    const alice = tab.get(ALICE)
    await alice.ready
    alice.add([uri(1)], 500)
    await alice.flush()

    const bob = new SeenListRegistry(deps(fake)).get(BOB)
    await bob.ready

    expect(bob.get(uri(1))).toBeUndefined()
    expect(bob.size).toBe(0)
  })

  it('retainOnly writes out and drops the other accounts', async () => {
    const tab = new SeenListRegistry(deps(fake))
    const alice = tab.get(ALICE)
    await alice.ready
    alice.add([uri(1)], 500)

    tab.retainOnly(BOB)
    await wait(10)

    expect(tab.peek(ALICE)).toBeUndefined()
    expect(storedRecords(fake, ALICE)).toHaveLength(1)
  })

  describe('two tabs', () => {
    it('shares written posts with the other tab', async () => {
      const channel = createChannelBus()
      const tabA = new SeenListRegistry(deps(fake, {channel: channel()}))
      const tabB = new SeenListRegistry(deps(fake, {channel: channel()}))
      const a = tabA.get(ALICE)
      const b = tabB.get(ALICE)
      await Promise.all([a.ready, b.ready])

      clock = 1_100_000
      a.add([uri(1)], 1_050_000)
      await a.flush()
      clock = 1_200_000
      await wait(5)

      expect(b.get(uri(1))).toEqual({seenAt: 1_050_000, knownAt: 1_200_000})
    })

    it('keeps the later seenAt whichever tab writes last', async () => {
      const channel = createChannelBus()
      const a = new SeenListRegistry(deps(fake, {channel: channel()})).get(
        ALICE,
      )
      const b = new SeenListRegistry(deps(fake, {channel: channel()})).get(
        ALICE,
      )
      await Promise.all([a.ready, b.ready])

      a.add([uri(1)], 900)
      b.add([uri(1)], 700)
      await a.flush()
      await b.flush()
      await wait(5)

      expect(storedRecords(fake).map(r => r.seenAt)).toEqual([900])
      expect(a.get(uri(1))?.seenAt).toBe(900)
      expect(b.get(uri(1))?.seenAt).toBe(900)
    })

    it('ignores messages for an account the tab has not loaded', async () => {
      const channel = createChannelBus()
      const tabA = new SeenListRegistry(deps(fake, {channel: channel()}))
      const tabB = new SeenListRegistry(deps(fake, {channel: channel()}))
      const a = tabA.get(ALICE)
      await a.ready
      a.add([uri(1)], 900)
      await a.flush()
      await wait(5)

      expect(tabB.peek(ALICE)).toBeUndefined()
    })
  })

  describe('unsynced marker', () => {
    it('marks new sightings as not yet synced', async () => {
      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready
      list.add([uri(1)], 500)
      await list.flush()

      expect(storedRecords(fake)[0]).toEqual({
        did: ALICE,
        uri: uri(1),
        seenAt: 500,
        dirty: 1,
      })
    })

    it('marks a synced record unsynced again when seen later', async () => {
      const {globals} = createFakeIndexedDbGlobals(fake)
      const db = await openSeenDb(globals)
      await writeSeen(db, globals, ALICE, [{uri: uri(1), seenAt: 500}], {
        dirty: 0,
      })
      expect(storedRecords(fake)[0].dirty).toBe(0)

      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready
      list.add([uri(1)], 600)
      await list.flush()

      expect(storedRecords(fake)[0]).toMatchObject({seenAt: 600, dirty: 1})
    })

    it('leaves a synced record alone when seen with an older time', async () => {
      const {globals} = createFakeIndexedDbGlobals(fake)
      const db = await openSeenDb(globals)
      await writeSeen(db, globals, ALICE, [{uri: uri(1), seenAt: 500}], {
        dirty: 0,
      })

      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready
      list.add([uri(1)], 400)
      await list.flush()

      expect(storedRecords(fake)[0]).toMatchObject({seenAt: 500, dirty: 0})
    })
  })

  describe('without storage', () => {
    it('works in memory when IndexedDB does not exist', async () => {
      const list = new SeenListRegistry(deps(null)).get(ALICE)
      await list.ready
      list.add([uri(1)], 500)
      await list.flush()

      expect(list.get(uri(1))?.seenAt).toBe(500)
      expect(list.isPersistent).toBe(false)
    })

    it('falls back to memory when the database will not open', async () => {
      fake.failOpen = true
      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready
      list.add([uri(1)], 500)
      await list.flush()

      expect(list.isPersistent).toBe(false)
      expect(list.get(uri(1))?.seenAt).toBe(500)
    })

    it('falls back to memory when opening never finishes', async () => {
      fake.hangOpen = true
      const list = new SeenListRegistry(deps(fake, {loadTimeoutMs: 20})).get(
        ALICE,
      )
      await list.ready

      expect(list.isPersistent).toBe(false)
    })

    it('falls back to memory when stored data cannot be read', async () => {
      const seed = new SeenListRegistry(deps(fake)).get(ALICE)
      await seed.ready
      seed.add([uri(1)], 500)
      await seed.flush()
      fake.setFailRequests(SEEN_DB_NAME, true)

      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready
      list.add([uri(2)], 600)

      expect(list.isPersistent).toBe(false)
      expect(list.get(uri(2))?.seenAt).toBe(600)
    })

    it('skips malformed records and keeps the rest', async () => {
      const {globals} = createFakeIndexedDbGlobals(fake)
      const db = await openSeenDb(globals)
      await writeSeen(db, globals, ALICE, [{uri: uri(1), seenAt: 500}])
      const store = fake.databases.get(SEEN_DB_NAME)!.stores.get(SEEN_STORE)!
      store.records.set('bad', {
        key: [ALICE, 'bad'],
        value: {did: ALICE, uri: 'bad', seenAt: 'yesterday'},
      })

      const list = new SeenListRegistry(deps(fake)).get(ALICE)
      await list.ready

      expect(list.size).toBe(1)
      expect(list.isPersistent).toBe(true)
    })

    it('keeps posts in memory after writes keep failing', async () => {
      const list = new SeenListRegistry(deps(fake, {flushIntervalMs: 1})).get(
        ALICE,
      )
      await list.ready
      fake.setFailRequests(SEEN_DB_NAME, true)
      list.add([uri(1)], 500)
      await wait(50)

      expect(list.isPersistent).toBe(false)
      expect(list.get(uri(1))?.seenAt).toBe(500)
    })

    it('retries a failed write', async () => {
      const list = new SeenListRegistry(deps(fake, {flushIntervalMs: 5})).get(
        ALICE,
      )
      await list.ready
      fake.setFailRequests(SEEN_DB_NAME, true)
      list.add([uri(1)], 500)
      await list.flush()
      fake.setFailRequests(SEEN_DB_NAME, false)
      await wait(30)

      expect(list.isPersistent).toBe(true)
      expect(storedRecords(fake)).toHaveLength(1)
    })
  })
})
