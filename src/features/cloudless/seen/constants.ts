/**
 * The most seen posts kept per account. Past this, the post seen longest ago
 * is dropped. The sync service (Story 4.1) applies the same limit, so it
 * imports or mirrors this value.
 */
export const SEEN_LIST_LIMIT = 100_000

/**
 * How long newly seen posts wait in memory before they are written as one
 * batch. Hiding the tab or leaving the page writes them at once.
 */
export const SEEN_FLUSH_INTERVAL_MS = 2_000

/**
 * The IndexedDB database. Schema version 1:
 *
 * - `seen`, keyed by `[did, uri]`, holds {@link SeenRecord}s, with the
 *   indexes `did_seenAt` on `[did, seenAt]` (rolling limit, look-back limit)
 *   and `did_dirty` on `[did, dirty]` (records not yet sent to the sync
 *   service).
 * - `meta`, keyed by `did`, holds {@link SeenMeta}.
 */
export const SEEN_DB_NAME = 'cloudless_seen'
export const SEEN_DB_VERSION = 1
export const SEEN_STORE = 'seen'
export const META_STORE = 'meta'
export const SEEN_BY_TIME_INDEX = 'did_seenAt'
export const SEEN_BY_DIRTY_INDEX = 'did_dirty'

/**
 * The BroadcastChannel that tells other open tabs about written batches.
 */
export const SEEN_CHANNEL_NAME = 'cloudless_seen'

/**
 * A seen post as stored in IndexedDB.
 */
export type SeenRecord = {
  did: string
  uri: string
  /**
   * When the post was seen, in milliseconds since the epoch. Writing an
   * existing `[did, uri]` keeps the later value.
   */
  seenAt: number
  /**
   * `1` until the record is sent to the sync service, `0` after. A number
   * because IndexedDB cannot index booleans.
   */
  dirty: 0 | 1
}

/**
 * Per-account sync state, used by the sync module (Story 4.2).
 */
export type SeenMeta = {
  did: string
  /**
   * The service's clock at the last successful pull.
   */
  lastSyncServerTime?: number
}
