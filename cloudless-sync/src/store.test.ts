import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, test} from 'node:test'

import {SEEN_LIST_LIMIT} from './constants.ts'
import {type ChangesPage, InvalidPositionError, SeenStore} from './store.ts'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

function uri(n: number | string) {
  return `at://did:plc:author/app.bsky.feed.post/${n}`
}

const stores: SeenStore[] = []
const dirs: string[] = []

function open(
  opts: ConstructorParameters<typeof SeenStore>[1] & {path?: string} = {},
) {
  const store = new SeenStore(opts.path ?? ':memory:', opts)
  stores.push(store)
  return store
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudless-sync-'))
  dirs.push(dir)
  return join(dir, 'seen.sqlite')
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true})
})

/**
 * Every page from `since`, following cursors.
 */
function fetchAll(store: SeenStore, did: string, since = 0) {
  const pages: ChangesPage[] = []
  let cursor: string | undefined
  do {
    const page = store.changes(did, {since, cursor})
    pages.push(page)
    cursor = page.cursor
  } while (cursor)
  return {
    pages,
    entries: pages.flatMap(p => p.entries),
    serverTime: pages[pages.length - 1].serverTime,
  }
}

function byUri(entries: {uri: string; seenAt: number}[]) {
  return Object.fromEntries(entries.map(e => [e.uri, e.seenAt]))
}

describe('SeenStore', () => {
  test('returns a stored batch', () => {
    const store = open()
    store.write(ALICE, [
      {uri: uri(1), seenAt: 100},
      {uri: uri(2), seenAt: 200},
    ])
    const {entries} = fetchAll(store, ALICE)
    assert.deepEqual(byUri(entries), {[uri(1)]: 100, [uri(2)]: 200})
  })

  test('returns only changes after `since`', () => {
    let clock = 1_000
    const store = open({now: () => clock})
    store.write(ALICE, [{uri: uri(1), seenAt: 100}])
    const first = fetchAll(store, ALICE)
    assert.equal(first.entries.length, 1)

    clock += 10
    store.write(ALICE, [
      {uri: uri(2), seenAt: 200},
      {uri: uri(1), seenAt: 150},
    ])
    const second = fetchAll(store, ALICE, first.serverTime)
    assert.deepEqual(byUri(second.entries), {[uri(1)]: 150, [uri(2)]: 200})

    const third = fetchAll(store, ALICE, second.serverTime)
    assert.deepEqual(third.entries, [])
    assert.ok(third.serverTime >= second.serverTime)
  })

  test('keeps the later time, and only a later time counts as a change', () => {
    const store = open()
    store.write(ALICE, [{uri: uri(1), seenAt: 500}])
    const {serverTime} = fetchAll(store, ALICE)

    store.write(ALICE, [{uri: uri(1), seenAt: 300}])
    store.write(ALICE, [{uri: uri(1), seenAt: 500}])
    assert.deepEqual(fetchAll(store, ALICE, serverTime).entries, [])
    assert.deepEqual(fetchAll(store, ALICE).entries, [
      {uri: uri(1), seenAt: 500},
    ])

    store.write(ALICE, [{uri: uri(1), seenAt: 900}])
    assert.deepEqual(fetchAll(store, ALICE, serverTime).entries, [
      {uri: uri(1), seenAt: 900},
    ])
  })

  test('keeps the latest of duplicates within one batch', () => {
    const store = open()
    store.write(ALICE, [
      {uri: uri(1), seenAt: 300},
      {uri: uri(1), seenAt: 700},
      {uri: uri(1), seenAt: 500},
    ])
    assert.deepEqual(fetchAll(store, ALICE).entries, [
      {uri: uri(1), seenAt: 700},
    ])
  })

  test('drops the posts seen longest ago past the limit', () => {
    const store = open({limit: 3})
    store.write(ALICE, [
      {uri: uri('a'), seenAt: 40},
      {uri: uri('b'), seenAt: 10},
      {uri: uri('c'), seenAt: 30},
    ])
    store.write(ALICE, [
      {uri: uri('d'), seenAt: 20},
      {uri: uri('e'), seenAt: 50},
    ])
    assert.equal(store.count(ALICE), 3)
    assert.deepEqual(byUri(fetchAll(store, ALICE).entries), {
      [uri('a')]: 40,
      [uri('c')]: 30,
      [uri('e')]: 50,
    })
  })

  test('breaks seenAt ties by URI when trimming, as IndexedDB does', () => {
    const store = open({limit: 2})
    store.write(ALICE, [
      {uri: uri('c'), seenAt: 10},
      {uri: uri('a'), seenAt: 10},
      {uri: uri('b'), seenAt: 10},
    ])
    assert.deepEqual(
      fetchAll(store, ALICE)
        .entries.map(e => e.uri)
        .sort(),
      [uri('b'), uri('c')],
    )
  })

  test('drops a new entry older than everything kept at the limit', () => {
    const store = open({limit: 2})
    store.write(ALICE, [
      {uri: uri('a'), seenAt: 20},
      {uri: uri('b'), seenAt: 30},
    ])
    store.write(ALICE, [{uri: uri('old'), seenAt: 10}])
    assert.deepEqual(byUri(fetchAll(store, ALICE).entries), {
      [uri('a')]: 20,
      [uri('b')]: 30,
    })
  })

  test(`never holds more than ${SEEN_LIST_LIMIT} entries per account`, () => {
    const store = open()
    const batch = 10_000
    for (let start = 0; start < SEEN_LIST_LIMIT + batch; start += batch) {
      const entries = []
      for (let i = start; i < start + batch; i++) {
        entries.push({uri: uri(i), seenAt: 1_000 + i})
      }
      store.write(ALICE, entries)
    }
    assert.equal(store.count(ALICE), SEEN_LIST_LIMIT)
    const {entries} = fetchAll(store, ALICE)
    assert.equal(entries.length, SEEN_LIST_LIMIT)
    const kept = new Set(entries.map(e => e.uri))
    // The first `batch` (seen longest ago) are gone; the newest are kept.
    assert.equal(kept.has(uri(batch - 1)), false)
    assert.equal(kept.has(uri(batch)), true)
    assert.equal(kept.has(uri(SEEN_LIST_LIMIT + batch - 1)), true)
  })

  test('pages through every entry, even where a page ends inside one batch', () => {
    const store = open({pageSize: 3})
    // One batch of 7 shares one updated_at, so pages split it.
    store.write(
      ALICE,
      Array.from({length: 7}, (_, i) => ({uri: uri(i), seenAt: i})),
    )
    store.write(ALICE, [{uri: uri(7), seenAt: 7}])
    const {pages, entries} = fetchAll(store, ALICE)
    assert.deepEqual(
      pages.map(p => p.entries.length),
      [3, 3, 2],
    )
    assert.equal(pages[2].cursor, undefined)
    assert.equal(new Set(entries.map(e => e.uri)).size, 8)
  })

  test('returns no cursor when the last page is exactly full', () => {
    const store = open({pageSize: 2})
    store.write(ALICE, [
      {uri: uri(1), seenAt: 1},
      {uri: uri(2), seenAt: 2},
    ])
    const {pages} = fetchAll(store, ALICE)
    assert.deepEqual(
      pages.map(p => p.entries.length),
      [2],
    )
  })

  test('a write between pages lands in a later page or the next check', () => {
    const store = open({pageSize: 2})
    store.write(
      ALICE,
      Array.from({length: 4}, (_, i) => ({uri: uri(i), seenAt: i})),
    )
    const first = store.changes(ALICE)
    assert.ok(first.cursor)
    // Moves an entry already delivered in the first page, and adds one.
    store.write(ALICE, [
      {uri: first.entries[0].uri, seenAt: 99},
      {uri: uri('new'), seenAt: 50},
    ])
    const rest: {uri: string; seenAt: number}[] = []
    let cursor: string | undefined = first.cursor
    let serverTime = first.serverTime
    while (cursor) {
      const page = store.changes(ALICE, {cursor})
      rest.push(...page.entries)
      cursor = page.cursor
      serverTime = page.serverTime
    }
    const seen = byUri([...first.entries, ...rest])
    assert.equal(seen[first.entries[0].uri], 99)
    assert.equal(seen[uri('new')], 50)
    assert.equal(Object.keys(seen).length, 5)
    assert.deepEqual(fetchAll(store, ALICE, serverTime).entries, [])
  })

  test('keeps writes in order when the system clock steps back', () => {
    let clock = 10_000
    const store = open({now: () => clock})
    store.write(ALICE, [{uri: uri(1), seenAt: 1}])
    const {serverTime} = fetchAll(store, ALICE)
    clock = 5_000
    store.write(ALICE, [{uri: uri(2), seenAt: 2}])
    assert.deepEqual(fetchAll(store, ALICE, serverTime).entries, [
      {uri: uri(2), seenAt: 2},
    ])
  })

  test('a reopened database continues after its latest change', () => {
    const path = tempDb()
    let clock = 10_000
    const first = open({path, now: () => clock})
    first.write(ALICE, [{uri: uri(1), seenAt: 1}])
    const {serverTime} = fetchAll(first, ALICE)
    first.close()

    clock = 1_000
    const second = open({path, now: () => clock})
    assert.deepEqual(fetchAll(second, ALICE).entries, [
      {uri: uri(1), seenAt: 1},
    ])
    second.write(ALICE, [{uri: uri(2), seenAt: 2}])
    assert.deepEqual(fetchAll(second, ALICE, serverTime).entries, [
      {uri: uri(2), seenAt: 2},
    ])
  })

  test('writes after a `since` from a replaced database are not missed', () => {
    let clock = 1_000
    const store = open({now: () => clock})
    // A device remembers a position from a database that ran further ahead.
    const since = 50_000
    assert.deepEqual(store.changes(ALICE, {since}).entries, [])
    store.write(ALICE, [{uri: uri(1), seenAt: 1}])
    clock = 2_000
    assert.deepEqual(fetchAll(store, ALICE, since).entries, [
      {uri: uri(1), seenAt: 1},
    ])
  })

  test('rejects a `since` far past its own clock', () => {
    const store = open({now: () => 1_000})
    assert.throws(
      () => store.changes(ALICE, {since: Number.MAX_SAFE_INTEGER}),
      InvalidPositionError,
    )
    // The clock did not move, so writes still order correctly.
    const a = store.write(ALICE, [{uri: uri(1), seenAt: 1}]).serverTime
    const b = store.write(ALICE, [{uri: uri(2), seenAt: 2}]).serverTime
    assert.ok(b > a)
    assert.deepEqual(store.changes(ALICE, {since: a}).entries, [
      {uri: uri(2), seenAt: 2},
    ])
  })

  test('keeps accounts apart', () => {
    const store = open({limit: 2})
    store.write(ALICE, [
      {uri: uri(1), seenAt: 1},
      {uri: uri(2), seenAt: 2},
    ])
    store.write(BOB, [
      {uri: uri(1), seenAt: 9},
      {uri: uri(3), seenAt: 3},
      {uri: uri(4), seenAt: 4},
    ])
    assert.deepEqual(byUri(fetchAll(store, ALICE).entries), {
      [uri(1)]: 1,
      [uri(2)]: 2,
    })
    assert.deepEqual(byUri(fetchAll(store, BOB).entries), {
      [uri(1)]: 9,
      [uri(4)]: 4,
    })
    assert.deepEqual(fetchAll(store, 'did:plc:carol').entries, [])
  })

  test('rejects a cursor it did not issue', () => {
    const store = open()
    assert.throws(
      () => store.changes(ALICE, {cursor: 'not-a-cursor'}),
      InvalidPositionError,
    )
    assert.throws(
      () =>
        store.changes(ALICE, {
          cursor: Buffer.from('{"a":1}').toString('base64url'),
        }),
      InvalidPositionError,
    )
  })

  test('a failed batch stores none of its entries', () => {
    const store = open()
    store.write(ALICE, [{uri: uri(1), seenAt: 1}])
    assert.throws(() =>
      store.write(ALICE, [
        {uri: uri(2), seenAt: 2},
        // SQLite rejects a NOT NULL violation mid-batch.
        {uri: null as unknown as string, seenAt: 3},
      ]),
    )
    assert.deepEqual(fetchAll(store, ALICE).entries, [{uri: uri(1), seenAt: 1}])
    store.write(ALICE, [{uri: uri(3), seenAt: 3}])
    assert.equal(store.count(ALICE), 2)
  })
})
