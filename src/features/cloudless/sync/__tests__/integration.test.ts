/*
 * Syncs real seen lists (on the fake IndexedDB) through a local copy of the
 * Story 4.1 service, started from `cloudless-sync/src` in dev mode. Needs the
 * service's dependencies (`cd cloudless-sync && pnpm install`); without
 * them the suite is skipped.
 *
 * Jest's global `fetch` is Expo's stub, so requests go through a small
 * `node:http` adapter.
 */
// oxlint-disable-next-line import/no-nodejs-modules
import {type ChildProcess, spawn} from 'node:child_process'
// oxlint-disable-next-line import/no-nodejs-modules
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
// oxlint-disable-next-line import/no-nodejs-modules
import http from 'node:http'
// oxlint-disable-next-line import/no-nodejs-modules
import net from 'node:net'
// oxlint-disable-next-line import/no-nodejs-modules
import os from 'node:os'
// oxlint-disable-next-line import/no-nodejs-modules
import path from 'node:path'
// oxlint-disable-next-line import/no-nodejs-modules
import zlib from 'node:zlib'

import {
  SEEN_DB_NAME,
  SEEN_LIST_LIMIT,
  SEEN_STORE,
  type SeenRecord,
} from '#/features/cloudless/seen/constants'
import {createIndexedDbStorage} from '#/features/cloudless/seen/db'
import {SeenListRegistry} from '#/features/cloudless/seen/seenList'
import {
  createFakeIndexedDbGlobals,
  FakeIndexedDb,
} from '#/features/cloudless/seen/testing/fakeIndexedDb'
import {createSyncClient} from '../client'
import {SeenSyncer, withoutLock} from '../SeenSyncer'

jest.mock('#/logger', () => ({
  logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn()},
}))

const SERVICE_DIR = path.resolve(__dirname, '../../../../../cloudless-sync')
const HAS_SERVICE = existsSync(
  path.join(SERVICE_DIR, 'node_modules', 'express'),
)

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

function uri(n: number | string) {
  return `at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/${n}`
}

type NodeResponse = {
  ok: boolean
  status: number
  headers: http.IncomingHttpHeaders
  json(): Promise<unknown>
}

/**
 * Enough of `fetch` for the sync client, over `node:http`.
 */
function nodeFetch(url: string, init?: RequestInit): Promise<NodeResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: init?.method ?? 'GET',
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          'Accept-Encoding': 'gzip',
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          let body = Buffer.concat(chunks)
          if (res.headers['content-encoding'] === 'gzip') {
            body = zlib.gunzipSync(body)
          }
          const status = res.statusCode ?? 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: res.headers,
            json: () => Promise.resolve(JSON.parse(body.toString('utf8'))),
          })
        })
        res.on('error', reject)
      },
    )
    init?.signal?.addEventListener('abort', () =>
      req.destroy(new Error('Aborted')),
    )
    req.on('error', reject)
    if (typeof init?.body === 'string') req.write(init.body)
    req.end()
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/**
 * The service in dev mode, on its own port and database file.
 */
class LocalService {
  private child: ChildProcess | undefined

  constructor(
    readonly port: number,
    readonly dbPath: string,
  ) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}/sync`
  }

  start(): Promise<void> {
    const child = spawn(process.execPath, ['src/bin.ts'], {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        CLOUDLESS_SYNC_PORT: String(this.port),
        CLOUDLESS_SYNC_DB: this.dbPath,
        CLOUDLESS_SYNC_DEV: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    return new Promise((resolve, reject) => {
      let output = ''
      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('"listening"')) resolve()
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('exit', code =>
        reject(new Error(`The service exited (${code}): ${output}`)),
      )
    })
  }

  stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return Promise.resolve()
    return new Promise(resolve => {
      child.on('exit', () => resolve())
      child.kill('SIGTERM')
    })
  }
}

function records(fake: FakeIndexedDb, did = ALICE) {
  return (fake.dump(SEEN_DB_NAME, SEEN_STORE) as SeenRecord[]).filter(
    r => r.did === did,
  )
}

let clock = Date.parse('2026-11-07T12:00:00.000Z')

function createDevice(
  service: LocalService,
  {did = ALICE, fake = new FakeIndexedDb()} = {},
) {
  const storage = createIndexedDbStorage(
    createFakeIndexedDbGlobals(fake).globals,
  )
  const lists = new SeenListRegistry({
    storage,
    channel: null,
    now: () => clock,
    limit: SEEN_LIST_LIMIT,
    flushIntervalMs: 60_000,
    loadTimeoutMs: 5_000,
  })
  const list = lists.get(did)
  const logs: {message: string; data?: Record<string, unknown>}[] = []
  const syncer = new SeenSyncer(list, {
    client: createSyncClient(service.baseUrl, {
      fetch: nodeFetch as unknown as typeof fetch,
    }),
    isVisible: () => true,
    withLock: withoutLock,
    log: (message, data) => logs.push({message, data}),
    intervalMs: 60_000,
    pushDelayMs: 60_000,
    retryBaseMs: 60_000,
  })
  return {fake, storage, list, syncer, logs}
}

const describeWithService = HAS_SERVICE ? describe : describe.skip

describeWithService('sync with the local service', () => {
  let tmp: string
  let service: LocalService
  const syncers: SeenSyncer[] = []

  function device(...args: Parameters<typeof createDevice>) {
    const d = createDevice(...args)
    syncers.push(d.syncer)
    return d
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cloudless-sync-it-'))
    service = new LocalService(await freePort(), path.join(tmp, 'seen.sqlite'))
    await service.start()
  })

  afterEach(async () => {
    for (const s of syncers.splice(0)) s.stop()
    await service.stop()
    rmSync(tmp, {recursive: true, force: true})
  })

  it('answers dev-mode CORS for the local dev server', async () => {
    const res = await nodeFetch(`${service.baseUrl}/health`, {
      headers: {Origin: 'http://localhost:8081'},
    })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:8081',
    )
  })

  it('shares one seen list between two devices', async () => {
    const phone = device(service)
    await phone.storage.write(ALICE, [{uri: uri('before-sync'), seenAt: 100}])
    await phone.list.ready
    phone.list.add([uri('a'), uri('b')], 200)
    await phone.syncer.sync({pull: true})
    expect(phone.logs.map(l => l.message)).toEqual(['synced'])
    expect(records(phone.fake).every(r => r.dirty === 0)).toBe(true)

    const laptop = device(service)
    await laptop.list.ready
    laptop.list.add([uri('a')], 300)
    await laptop.syncer.sync({pull: true})
    expect(laptop.list.get(uri('before-sync'))?.seenAt).toBe(100)
    expect(laptop.list.get(uri('b'))?.seenAt).toBe(200)
    // The laptop's later sighting wins on both.
    expect(laptop.list.get(uri('a'))?.seenAt).toBe(300)
    await phone.syncer.sync({pull: true})
    expect(phone.list.get(uri('a'))?.seenAt).toBe(300)
    expect(records(phone.fake).every(r => r.dirty === 0)).toBe(true)
  })

  it('brings down a long list in pages on a first sync', async () => {
    const phone = device(service)
    const entries = Array.from({length: 12_000}, (_, i) => ({
      uri: uri(i),
      seenAt: 1_700_000_000_000 + i,
    }))
    await phone.storage.write(ALICE, entries)
    await phone.syncer.sync({pull: false})
    expect(phone.logs.at(-1)).toMatchObject({
      message: 'synced',
      data: {sent: 12_000},
    })

    const laptop = device(service)
    await laptop.syncer.sync({pull: true})
    expect(laptop.logs.at(-1)).toMatchObject({
      message: 'synced',
      data: {received: {entries: 12_000, pages: 3}, sent: 0},
    })
    expect(laptop.list.size).toBe(12_000)
    expect(records(laptop.fake)).toHaveLength(12_000)
  }, 60_000)

  it('keeps accounts apart', async () => {
    const alice = device(service, {did: ALICE})
    const bob = device(service, {did: BOB})
    await alice.list.ready
    await bob.list.ready
    alice.list.add([uri('alice')], 1)
    bob.list.add([uri('bob')], 2)
    await alice.syncer.sync({pull: true})
    await bob.syncer.sync({pull: true})
    await alice.syncer.sync({pull: true})
    expect(alice.list.get(uri('bob'))).toBeUndefined()
    expect(bob.list.get(uri('alice'))).toBeUndefined()
    expect(bob.list.get(uri('bob'))).toBeDefined()
  })

  it('keeps posts seen while the service is down and sends them once it is back', async () => {
    const phone = device(service)
    await phone.syncer.sync({pull: true})
    await service.stop()

    await phone.list.ready
    phone.list.add([uri('offline')], 500)
    await phone.syncer.sync({pull: true})
    expect(phone.logs.at(-1)?.message).toBe('sync failed')
    // The seen list's own write timer stores it, still marked unsynced.
    await phone.list.flush()
    expect(records(phone.fake)).toEqual([
      expect.objectContaining({uri: uri('offline'), dirty: 1}),
    ])

    // Same database file: the restarted service keeps its data.
    await service.start()
    phone.syncer.resume()
    for (let i = 0; i < 200 && phone.logs.at(-1)?.message !== 'synced'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(phone.logs.at(-1)?.message).toBe('synced')

    const laptop = device(service)
    await laptop.syncer.sync({pull: true})
    expect(laptop.list.get(uri('offline'))?.seenAt).toBe(500)
  })
})

if (!HAS_SERVICE) {
  it('skips the service integration test (run `pnpm install` in cloudless-sync)', () => {})
}
