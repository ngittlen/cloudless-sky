/*
 * An in-memory stand-in for the Story 4.1 service, for unit tests: later
 * seenAt wins, `updated_at` moves only when `seenAt` does, and changes are
 * paged in `(updatedAt, uri)` order. Requests can be failed or held.
 */
import {type SeenEntry} from '#/features/cloudless/seen/db'
import {type PulledPage, type SyncClient, SyncHttpError} from '../client'

export type FakeRequest =
  | {type: 'pull'; did: string; since?: number; cursor?: string}
  | {type: 'push' | 'keepalive'; did: string; entries: SeenEntry[]}

export class FakeSyncService {
  rows = new Map<string, Map<string, {seenAt: number; updatedAt: number}>>()
  clock = 1_000
  pageSize: number
  requests: FakeRequest[] = []
  /**
   * While set, every request fails as a network error would.
   */
  offline = false
  /**
   * Runs before each request is answered; throw to fail it, or return a
   * promise to hold it.
   */
  onRequest: ((req: FakeRequest) => void | Promise<void>) | undefined

  constructor({pageSize = 5_000}: {pageSize?: number} = {}) {
    this.pageSize = pageSize
  }

  write(did: string, entries: SeenEntry[]) {
    const updatedAt = ++this.clock
    let rows = this.rows.get(did)
    if (!rows) {
      rows = new Map()
      this.rows.set(did, rows)
    }
    for (const {uri, seenAt} of entries) {
      const row = rows.get(uri)
      if (!row || row.seenAt < seenAt) rows.set(uri, {seenAt, updatedAt})
    }
    return updatedAt
  }

  entries(did: string): Record<string, number> {
    return Object.fromEntries(
      [...(this.rows.get(did) ?? [])].map(([uri, r]) => [uri, r.seenAt]),
    )
  }

  changes(did: string, since = 0, cursor?: string): PulledPage {
    if (since > this.clock + 1_000_000) {
      throw new SyncHttpError(400, 'HTTP 400: since is too late')
    }
    const after = cursor ? (JSON.parse(cursor) as [number, string]) : undefined
    const rows = [...(this.rows.get(did) ?? [])]
      .filter(([, r]) => r.updatedAt > since)
      .filter(
        ([uri, r]) =>
          !after ||
          r.updatedAt > after[0] ||
          (r.updatedAt === after[0] && uri > after[1]),
      )
      .sort(
        ([ua, a], [ub, b]) =>
          a.updatedAt - b.updatedAt || (ua < ub ? -1 : ua > ub ? 1 : 0),
      )
    const page = rows.slice(0, this.pageSize)
    const last = page[page.length - 1]
    return {
      entries: page.map(([uri, r]) => ({uri, seenAt: r.seenAt})),
      serverTime: this.clock,
      cursor:
        rows.length > this.pageSize
          ? JSON.stringify([last[1].updatedAt, last[0]])
          : undefined,
    }
  }

  private async handle(req: FakeRequest, signal?: AbortSignal) {
    this.requests.push(req)
    await this.onRequest?.(req)
    if (signal?.aborted) throw new Error('Aborted')
    if (this.offline) throw new TypeError('Failed to fetch')
  }

  client(): SyncClient {
    return {
      pull: async (did, {since, cursor}, signal) => {
        await this.handle({type: 'pull', did, since, cursor}, signal)
        return structuredClone(this.changes(did, since, cursor))
      },
      push: async (did, entries, signal) => {
        await this.handle(
          {type: 'push', did, entries: structuredClone(entries)},
          signal,
        )
        this.write(did, entries)
      },
      pushKeepalive: async (did, entries) => {
        await this.handle({
          type: 'keepalive',
          did,
          entries: structuredClone(entries),
        })
        this.write(did, entries)
      },
    }
  }
}
