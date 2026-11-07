/**
 * How often a visible page pulls and pushes.
 */
export const SYNC_INTERVAL_MS = 30_000

/**
 * How long after a post is seen to push it. Longer than the seen list's
 * 2-second write interval, so the sighting is in IndexedDB by then.
 */
export const PUSH_DELAY_MS = 5_000

/**
 * The first retry delay after a failure. It doubles with each further
 * failure, up to {@link RETRY_MAX_MS}.
 */
export const RETRY_BASE_MS = 5_000
export const RETRY_MAX_MS = 5 * 60_000

/**
 * Entries per push: the most the service accepts in one request.
 */
export const PUSH_BATCH_SIZE = 1_000

/**
 * Push requests per sync run. Enough for a full list of 100,000 posts seen
 * before sync existed; anything left goes in the next run.
 */
export const MAX_PUSH_BATCHES = 120

/**
 * Pages per pull. The service sends 5,000 entries a page, so a full list is
 * 20 pages; more means the cursor is not advancing.
 */
export const MAX_PULL_PAGES = 100

/**
 * How long one request may take before it is abandoned and retried later.
 * It bounds how long a stuck request holds the cross-tab sync lock.
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * The largest body sent with `keepalive` while the page is hidden or
 * unloaded. Browsers cap the bodies of a document's in-flight keepalive
 * requests at 64 KiB in total.
 */
export const KEEPALIVE_MAX_BYTES = 60_000
