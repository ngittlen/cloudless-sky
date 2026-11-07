import {type SeenEntry} from '#/features/cloudless/seen/db'
import {KEEPALIVE_MAX_BYTES, REQUEST_TIMEOUT_MS} from './constants'

/**
 * One page of `GET /seen`.
 */
export type PulledPage = {
  entries: SeenEntry[]
  serverTime: number
  cursor?: string
}

/**
 * The service answered with an error status.
 */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SyncHttpError'
  }
}

export type SyncClient = {
  pull(
    did: string,
    position: {since?: number; cursor?: string},
    signal: AbortSignal,
  ): Promise<PulledPage>
  push(did: string, entries: SeenEntry[], signal: AbortSignal): Promise<void>
  /**
   * Sends a batch with `keepalive`, so it completes after the page is gone.
   * The caller keeps the body under {@link KEEPALIVE_MAX_BYTES}.
   */
  pushKeepalive(did: string, entries: SeenEntry[]): Promise<void>
}

type Fetch = typeof fetch

/**
 * The longest URI the service accepts (`MAX_URI_LENGTH` in
 * `cloudless-sync/src/constants.ts`).
 */
const MAX_URI_LENGTH = 8_192

/**
 * Whether the service accepts the entry. Anything else would make it reject
 * the whole batch.
 */
export function isSendable(entry: SeenEntry): boolean {
  return (
    entry.uri.startsWith('at://') &&
    entry.uri.length <= MAX_URI_LENGTH &&
    Number.isSafeInteger(entry.seenAt) &&
    entry.seenAt >= 0
  )
}

function parsePage(value: unknown): PulledPage {
  if (value && typeof value === 'object') {
    const {entries, serverTime, cursor} = value as Partial<PulledPage>
    if (
      Array.isArray(entries) &&
      typeof serverTime === 'number' &&
      Number.isFinite(serverTime) &&
      (cursor === undefined || typeof cursor === 'string')
    ) {
      return {entries, serverTime, cursor: cursor || undefined}
    }
  }
  throw new Error('The sync service sent an unexpected response')
}

async function errorFrom(res: Response): Promise<SyncHttpError> {
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as {message?: unknown}
    if (typeof body.message === 'string') message += `: ${body.message}`
  } catch {}
  return new SyncHttpError(res.status, message)
}

/**
 * Runs `fn` with a signal that aborts when `signal` does or after
 * `timeoutMs`.
 */
async function withTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort)
  const timer = setTimeout(abort, timeoutMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * The HTTP client for the Story 4.1 service at `baseUrl` (for example
 * `/sync`).
 */
export function createSyncClient(
  baseUrl: string,
  {
    fetch: fetchImpl = (...args) => fetch(...args),
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: {fetch?: Fetch; timeoutMs?: number} = {},
): SyncClient {
  const post = (did: string, entries: SeenEntry[], init: RequestInit) =>
    fetchImpl(`${baseUrl}/seen`, {
      ...init,
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({did, entries}),
    })

  return {
    pull: (did, {since, cursor}, signal) =>
      withTimeout(signal, timeoutMs, async timeoutSignal => {
        const params = new URLSearchParams({did})
        if (since !== undefined) params.set('since', String(since))
        if (cursor !== undefined) params.set('cursor', cursor)
        const res = await fetchImpl(`${baseUrl}/seen?${params}`, {
          signal: timeoutSignal,
          cache: 'no-store',
        })
        if (!res.ok) throw await errorFrom(res)
        return parsePage(await res.json())
      }),
    push: (did, entries, signal) =>
      withTimeout(signal, timeoutMs, async timeoutSignal => {
        const res = await post(did, entries, {signal: timeoutSignal})
        if (!res.ok) throw await errorFrom(res)
      }),
    pushKeepalive: async (did, entries) => {
      const res = await post(did, entries, {keepalive: true})
      if (!res.ok) throw await errorFrom(res)
    },
  }
}

const encoder = new TextEncoder()

function byteLength(text: string) {
  return encoder.encode(text).length
}

/**
 * The longest prefix of `entries` whose `POST /seen` body for `did` fits in
 * `maxBytes`.
 */
export function fitKeepaliveBatch(
  did: string,
  entries: SeenEntry[],
  maxBytes = KEEPALIVE_MAX_BYTES,
): SeenEntry[] {
  let size = byteLength(JSON.stringify({did, entries: []}))
  const batch: SeenEntry[] = []
  for (const entry of entries) {
    // Every entry after the first adds a comma.
    const added = byteLength(JSON.stringify(entry)) + (batch.length > 0 ? 1 : 0)
    if (size + added > maxBytes) break
    size += added
    batch.push(entry)
  }
  return batch
}
