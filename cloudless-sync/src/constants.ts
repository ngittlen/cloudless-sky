/**
 * The most seen posts kept per account. Past this, the post seen longest ago
 * is dropped. Mirrors `SEEN_LIST_LIMIT` in the app's
 * `src/features/cloudless/seen/constants.ts`, so a device and the service
 * keep the same posts; `constants.test.ts` fails when the two differ.
 */
export const SEEN_LIST_LIMIT = 100_000

/**
 * The most entries one `POST /seen` may carry. The app sends batches of at
 * most this size.
 */
export const MAX_BATCH_SIZE = 1_000

/**
 * The largest JSON body `POST /seen` accepts. A full batch of long URIs is
 * well under it.
 */
export const MAX_BODY_BYTES = 512 * 1024

/**
 * Entries per `GET /seen` page. A full list of 100,000 takes 20 pages.
 */
export const PAGE_SIZE = 5_000

/**
 * The longest `did` and `uri` accepted. Real values are far shorter; the cap
 * keeps a malformed request from storing arbitrarily large strings.
 */
export const MAX_DID_LENGTH = 2_048
export const MAX_URI_LENGTH = 8_192
