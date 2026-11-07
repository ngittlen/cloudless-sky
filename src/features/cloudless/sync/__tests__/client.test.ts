import {
  createSyncClient,
  fitKeepaliveBatch,
  isSendable,
  SyncHttpError,
} from '../client'

const ALICE = 'did:plc:alice'

function uri(n: number | string) {
  return `at://did:plc:author/app.bsky.feed.post/${n}`
}

type Call = {url: string; init: RequestInit | undefined}

function fakeFetch(respond: (call: Call) => {status: number; body: unknown}) {
  const calls: Call[] = []
  const impl = (url: string, init?: RequestInit) => {
    const call = {url, init}
    calls.push(call)
    const {status, body} = respond(call)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  }
  return {calls, fetch: impl as typeof fetch}
}

const signal = new AbortController().signal

describe('sync client', () => {
  it('pulls with since and cursor', async () => {
    const {calls, fetch} = fakeFetch(() => ({
      status: 200,
      body: {entries: [{uri: uri(1), seenAt: 1}], serverTime: 5, cursor: 'c2'},
    }))
    const client = createSyncClient('/sync', {fetch})
    const page = await client.pull(ALICE, {since: 3, cursor: 'c1'}, signal)
    expect(page).toEqual({
      entries: [{uri: uri(1), seenAt: 1}],
      serverTime: 5,
      cursor: 'c2',
    })
    expect(calls[0].url).toBe(
      `/sync/seen?did=${encodeURIComponent(ALICE)}&since=3&cursor=c1`,
    )
  })

  it('posts a batch as JSON', async () => {
    const {calls, fetch} = fakeFetch(() => ({
      status: 200,
      body: {serverTime: 1},
    }))
    const client = createSyncClient('/sync', {fetch})
    await client.push(ALICE, [{uri: uri(1), seenAt: 1}], signal)
    await client.pushKeepalive(ALICE, [{uri: uri(2), seenAt: 2}])
    expect(calls.map(c => [c.url, c.init?.method, c.init?.keepalive])).toEqual([
      ['/sync/seen', 'POST', undefined],
      ['/sync/seen', 'POST', true],
    ])
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      did: ALICE,
      entries: [{uri: uri(1), seenAt: 1}],
    })
  })

  it('reports error statuses with the service message', async () => {
    const {fetch} = fakeFetch(() => ({
      status: 400,
      body: {error: 'InvalidRequest', message: 'did must be a string'},
    }))
    const client = createSyncClient('/sync', {fetch})
    const error: unknown = await client.pull(ALICE, {}, signal).catch(e => e)
    expect(error).toBeInstanceOf(SyncHttpError)
    expect(error).toMatchObject({status: 400})
    expect((error as SyncHttpError).message).toContain('did must be a string')
  })

  it('rejects a malformed response', async () => {
    const {fetch} = fakeFetch(() => ({status: 200, body: {entries: 'x'}}))
    const client = createSyncClient('/sync', {fetch})
    await expect(client.pull(ALICE, {}, signal)).rejects.toThrow(
      'unexpected response',
    )
  })

  it('gives up on a request that takes too long', async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        )
      })) as typeof globalThis.fetch
    const client = createSyncClient('/sync', {fetch, timeoutMs: 10})
    await expect(client.pull(ALICE, {}, signal)).rejects.toThrow('aborted')
  })
})

describe('fitKeepaliveBatch', () => {
  it('keeps the body within the byte limit', () => {
    const entries = Array.from({length: 5_000}, (_, i) => ({
      uri: uri(`é${i}`),
      seenAt: 1_700_000_000_000 + i,
    }))
    const batch = fitKeepaliveBatch(ALICE, entries, 60_000)
    const size = new TextEncoder().encode(
      JSON.stringify({did: ALICE, entries: batch}),
    ).length
    expect(size).toBeLessThanOrEqual(60_000)
    expect(batch.length).toBeGreaterThan(0)
    const oneMore = new TextEncoder().encode(
      JSON.stringify({did: ALICE, entries: entries.slice(0, batch.length + 1)}),
    ).length
    expect(oneMore).toBeGreaterThan(60_000)
  })
})

describe('isSendable', () => {
  it('accepts only what the service accepts', () => {
    expect(isSendable({uri: uri(1), seenAt: 1})).toBe(true)
    expect(isSendable({uri: 'https://x', seenAt: 1})).toBe(false)
    expect(isSendable({uri: uri(1), seenAt: 1.5})).toBe(false)
    expect(isSendable({uri: uri(1), seenAt: -1})).toBe(false)
    expect(isSendable({uri: `at://${'x'.repeat(9_000)}`, seenAt: 1})).toBe(
      false,
    )
  })
})
