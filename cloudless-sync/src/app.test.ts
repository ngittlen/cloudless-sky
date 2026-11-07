import assert from 'node:assert/strict'
import {type AddressInfo} from 'node:net'
import {after, before, describe, test} from 'node:test'
import {gzipSync} from 'node:zlib'

import {createApp, type Logger} from './app.ts'
import {MAX_BATCH_SIZE, SEEN_LIST_LIMIT} from './constants.ts'
import {SeenStore} from './store.ts'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

function uri(n: number | string) {
  return `at://did:plc:author/app.bsky.feed.post/${n}`
}

const quiet: Logger = {info() {}, error() {}}

async function startServer({
  dev = false,
  store = new SeenStore(':memory:'),
}: {dev?: boolean; store?: SeenStore} = {}) {
  const app = createApp({store, dev, logger: quiet})
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const {port} = server.address() as AddressInfo
  return {
    store,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      store.close()
    },
  }
}

type Server = Awaited<ReturnType<typeof startServer>>

function post(base: string, body: unknown, path = '/sync/seen') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function getAll(base: string, did: string, since?: number) {
  const entries: {uri: string; seenAt: number}[] = []
  let cursor: string | undefined
  let serverTime = 0
  let pages = 0
  do {
    const params = new URLSearchParams({did})
    if (since !== undefined) params.set('since', String(since))
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${base}/sync/seen?${params}`)
    assert.equal(res.status, 200)
    const page = (await res.json()) as {
      entries: {uri: string; seenAt: number}[]
      serverTime: number
      cursor?: string
    }
    entries.push(...page.entries)
    cursor = page.cursor
    serverTime = page.serverTime
    pages++
  } while (cursor)
  return {entries, serverTime, pages}
}

describe('HTTP API', () => {
  let server: Server
  before(async () => {
    server = await startServer()
  })
  after(() => server.close())

  test('stores a batch and returns it', async () => {
    const res = await post(server.base, {
      did: ALICE,
      entries: [
        {uri: uri(1), seenAt: 100},
        {uri: uri(2), seenAt: 200},
      ],
    })
    assert.equal(res.status, 200)
    const {serverTime} = (await res.json()) as {serverTime: number}
    assert.equal(typeof serverTime, 'number')

    const {entries} = await getAll(server.base, ALICE)
    assert.deepEqual(
      entries.sort((a, b) => a.seenAt - b.seenAt),
      [
        {uri: uri(1), seenAt: 100},
        {uri: uri(2), seenAt: 200},
      ],
    )
  })

  test('returns only changes since a previous check, keeping the later time', async () => {
    const did = 'did:plc:since'
    await post(server.base, {did, entries: [{uri: uri(1), seenAt: 500}]})
    const first = await getAll(server.base, did)

    await post(server.base, {
      did,
      entries: [
        {uri: uri(1), seenAt: 400},
        {uri: uri(2), seenAt: 300},
      ],
    })
    const second = await getAll(server.base, did, first.serverTime)
    assert.deepEqual(second.entries, [{uri: uri(2), seenAt: 300}])

    const all = await getAll(server.base, did)
    assert.deepEqual(
      Object.fromEntries(all.entries.map(e => [e.uri, e.seenAt])),
      {[uri(1)]: 500, [uri(2)]: 300},
    )
  })

  test('answers with and without the /sync prefix', async () => {
    const did = 'did:plc:prefix'
    const res = await post(
      server.base,
      {did, entries: [{uri: uri(1), seenAt: 1}]},
      '/seen',
    )
    assert.equal(res.status, 200)
    const viaRoot = await fetch(`${server.base}/seen?did=${did}`)
    const viaPrefix = await fetch(`${server.base}/sync/seen?did=${did}`)
    assert.deepEqual(
      ((await viaRoot.json()) as {entries: unknown}).entries,
      ((await viaPrefix.json()) as {entries: unknown}).entries,
    )
    for (const path of ['/health', '/sync/health']) {
      const health = await fetch(`${server.base}${path}`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), {status: 'ok'})
    }
  })

  test('keeps accounts apart', async () => {
    await post(server.base, {did: BOB, entries: [{uri: uri('b'), seenAt: 1}]})
    const bob = await getAll(server.base, BOB)
    assert.deepEqual(bob.entries, [{uri: uri('b'), seenAt: 1}])
    const alice = await getAll(server.base, ALICE)
    assert.equal(
      alice.entries.some(e => e.uri === uri('b')),
      false,
    )
  })

  test('marks responses as not cacheable', async () => {
    const res = await fetch(`${server.base}/sync/seen?did=${ALICE}`)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  describe('rejects malformed requests without changing stored data', () => {
    const did = 'did:plc:guarded'

    before(async () => {
      await post(server.base, {did, entries: [{uri: uri(1), seenAt: 10}]})
    })

    const badBodies: [string, unknown][] = [
      ['a body that is not an object', '[1, 2]'],
      ['a missing did', {entries: []}],
      ['a did without "did:"', {did: 'alice', entries: []}],
      ['entries that are not an array', {did, entries: {}}],
      ['an entry that is not an object', {did, entries: [1]}],
      [
        'a uri without "at://"',
        {did, entries: [{uri: 'https://x', seenAt: 1}]},
      ],
      ['a missing seenAt', {did, entries: [{uri: uri(1)}]}],
      [
        'a seenAt that is a string',
        {did, entries: [{uri: uri(1), seenAt: '99'}]},
      ],
      ['a negative seenAt', {did, entries: [{uri: uri(1), seenAt: -1}]}],
      ['a fractional seenAt', {did, entries: [{uri: uri(1), seenAt: 1.5}]}],
      [
        'one bad entry after good ones',
        {
          did,
          entries: [
            {uri: uri(1), seenAt: 999},
            {uri: uri(2), seenAt: 999},
            {uri: 'bad', seenAt: 999},
          ],
        },
      ],
      [
        `more than ${MAX_BATCH_SIZE} entries`,
        {
          did,
          entries: Array.from({length: MAX_BATCH_SIZE + 1}, (_, i) => ({
            uri: uri(i),
            seenAt: 999,
          })),
        },
      ],
      ['invalid JSON', '{"did": '],
    ]

    for (const [name, body] of badBodies) {
      test(name, async () => {
        const res = await post(server.base, body)
        assert.equal(res.status, 400)
        const json = (await res.json()) as {error: string; message: string}
        assert.equal(json.error, 'InvalidRequest')
        assert.ok(json.message.length > 0)
        const {entries} = await getAll(server.base, did)
        assert.deepEqual(entries, [{uri: uri(1), seenAt: 10}])
      })
    }

    test('a body that is not JSON', async () => {
      const res = await fetch(`${server.base}/sync/seen`, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain'},
        body: JSON.stringify({did, entries: [{uri: uri(1), seenAt: 999}]}),
      })
      assert.equal(res.status, 400)
      assert.match(
        ((await res.json()) as {message: string}).message,
        /Content-Type/,
      )
    })

    test('a body over the size limit', async () => {
      const res = await post(server.base, {
        did,
        entries: [{uri: `at://${'x'.repeat(600_000)}`, seenAt: 999}],
      })
      assert.equal(res.status, 413)
      assert.equal(
        ((await res.json()) as {error: string}).error,
        'PayloadTooLarge',
      )
    })

    const badQueries: [string, string][] = [
      ['a missing did', ''],
      ['a did without "did:"', 'did=alice'],
      ['a since that is not a number', `did=${did}&since=abc`],
      ['a negative since', `did=${did}&since=-5`],
      ['a repeated since', `did=${did}&since=1&since=2`],
      ['an unknown cursor', `did=${did}&cursor=garbage`],
      [
        'a since far in the future',
        `did=${did}&since=${Number.MAX_SAFE_INTEGER}`,
      ],
    ]
    for (const [name, query] of badQueries) {
      test(`GET with ${name}`, async () => {
        const res = await fetch(`${server.base}/sync/seen?${query}`)
        assert.equal(res.status, 400)
        assert.equal(
          ((await res.json()) as {error: string}).error,
          'InvalidRequest',
        )
      })
    }

    test('an unknown route', async () => {
      const res = await fetch(`${server.base}/sync/other`)
      assert.equal(res.status, 404)
    })
  })
})

describe('CORS', () => {
  test('is off outside dev mode', async () => {
    const server = await startServer()
    try {
      const res = await fetch(`${server.base}/sync/seen?did=${ALICE}`, {
        headers: {Origin: 'http://localhost:8081'},
      })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      const preflight = await fetch(`${server.base}/sync/seen`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:8081',
          'Access-Control-Request-Method': 'POST',
        },
      })
      assert.equal(preflight.headers.get('access-control-allow-origin'), null)
    } finally {
      await server.close()
    }
  })

  test('allows http://localhost:* in dev mode, and nothing else', async () => {
    const server = await startServer({dev: true})
    try {
      const preflight = await fetch(`${server.base}/sync/seen`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:8081',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      })
      assert.equal(preflight.status, 204)
      assert.equal(
        preflight.headers.get('access-control-allow-origin'),
        'http://localhost:8081',
      )
      assert.match(
        preflight.headers.get('access-control-allow-headers') ?? '',
        /Content-Type/i,
      )
      for (const origin of [
        'https://localhost:8081',
        'http://localhost.evil.example',
        'http://example.com',
      ]) {
        const res = await fetch(`${server.base}/sync/seen?did=${ALICE}`, {
          headers: {Origin: origin},
        })
        assert.equal(
          res.headers.get('access-control-allow-origin'),
          null,
          origin,
        )
      }
    } finally {
      await server.close()
    }
  })
})

describe('first sync of a full list', () => {
  test(`fetches ${SEEN_LIST_LIMIT} entries in compressed pages, quickly`, async () => {
    const server = await startServer()
    try {
      const did = 'did:plc:full'
      const batch = 10_000
      for (let start = 0; start < SEEN_LIST_LIMIT; start += batch) {
        server.store.write(
          did,
          Array.from({length: batch}, (_, i) => ({
            // Realistic lengths: a did:plc author and a TID record key.
            uri: `at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3l${String(start + i).padStart(11, '0')}`,
            seenAt: 1_700_000_000_000 + start + i,
          })),
        )
      }

      const started = performance.now()
      let raw = 0
      let compressed = 0
      let pages = 0
      let count = 0
      let cursor: string | undefined
      do {
        const params = new URLSearchParams({did})
        if (cursor) params.set('cursor', cursor)
        const res = await fetch(`${server.base}/sync/seen?${params}`, {
          headers: {'Accept-Encoding': 'gzip'},
        })
        assert.equal(res.headers.get('content-encoding'), 'gzip')
        const text = await res.text()
        compressed += gzipSync(text).length
        raw += text.length
        const page = JSON.parse(text) as {
          entries: unknown[]
          cursor?: string
        }
        count += page.entries.length
        cursor = page.cursor
        pages++
      } while (cursor)
      const elapsed = performance.now() - started

      assert.equal(count, SEEN_LIST_LIMIT)
      assert.ok(pages > 1)
      assert.ok(elapsed < 10_000, `took ${Math.round(elapsed)} ms`)
      console.log(
        `full list: ${pages} pages, ${(raw / 1e6).toFixed(1)} MB JSON, ` +
          `about ${(compressed / 1e6).toFixed(1)} MB gzipped, ` +
          `${Math.round(elapsed)} ms`,
      )
    } finally {
      await server.close()
    }
  })
})
