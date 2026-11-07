import {logger} from '#/logger'
import {IS_DEV} from '#/env'

/**
 * Something the user has seen in Following: every post URI shown in one feed
 * unit, for one account, at one moment.
 */
export type SeenEvent = {
  did: string
  uris: string[]
  /**
   * Milliseconds since the epoch.
   */
  seenAt: number
}

type SeenListener = (event: SeenEvent) => void

/**
 * The parts of a feed slice the recorder reads. Both the legacy and the
 * Following v2 `PostFeed` build rows of this shape.
 */
type SliceLike<T> = {
  items: T[]
  isIncompleteThread: boolean
}

type SliceItemRow = {
  type: 'sliceItem'
  slice: SliceLike<{uri: string}>
  indexInSlice: number
}

/**
 * Session dedupe, keyed by `did + ' ' + uri`. It stops a unit that scrolls
 * in and out of view from emitting the same posts again. Cleared at the
 * seen-list limit so a session that never reloads cannot grow it without
 * bound.
 */
const recorded = new Set<string>()
const RECORDED_SESSION_LIMIT = 100_000

const listeners = new Set<SeenListener>()

/**
 * The items of a slice that the feed actually renders. A long thread whose
 * parent is not a direct reply to the root renders as the root, a "view full
 * thread" link, then the last two posts, so the posts in between are never on
 * screen. This mirrors the `isIncompleteThread && items.length >= 3` branch
 * that builds feed rows in `PostFeed.tsx`.
 */
export function getDisplayedSliceItems<T>(slice: SliceLike<T>): T[] {
  const {items} = slice
  if (slice.isIncompleteThread && items.length >= 3) {
    return [items[0], items[items.length - 2], items[items.length - 1]]
  }
  return items
}

function isSliceItemRow(row: unknown): row is SliceItemRow {
  if (!row || typeof row !== 'object') return false
  const r = row as Partial<SliceItemRow>
  return (
    r.type === 'sliceItem' &&
    !!r.slice &&
    Array.isArray(r.slice.items) &&
    typeof r.indexInSlice === 'number'
  )
}

/**
 * Called with every feed row the list reports as seen (well on screen for
 * about half a second). Only rows in the Following feed count, and a slice
 * counts only once its last item, the newest post in the unit, has been seen.
 * At that point every displayed post in the unit is recorded by post URI, so
 * a repost matches the original post.
 */
export function recordSeenFeedRow(
  feedDescriptor: string | undefined,
  did: string | undefined,
  row: unknown,
  now: number = Date.now(),
) {
  if (feedDescriptor !== 'following' || !did) return
  if (!isSliceItemRow(row)) return
  const {slice, indexInSlice} = row
  if (indexInSlice !== slice.items.length - 1) return

  const uris: string[] = []
  for (const item of getDisplayedSliceItems(slice)) {
    const key = did + ' ' + item.uri
    if (recorded.has(key)) continue
    recorded.add(key)
    uris.push(item.uri)
  }
  if (uris.length === 0) return
  if (recorded.size > RECORDED_SESSION_LIMIT) recorded.clear()

  const event: SeenEvent = {did, uris, seenAt: now}
  if (IS_DEV) {
    logger.info('[cloudless] recorded as seen', {did, uris})
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (e) {
      logger.error('[cloudless] seen listener failed', {safeMessage: e})
    }
  }
}

/**
 * Subscribes to seen events. Returns the unsubscribe function.
 */
export function subscribeToSeen(listener: SeenListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether this session has already recorded `uri` as seen for `did`.
 */
export function hasRecordedSeen(did: string, uri: string): boolean {
  return recorded.has(did + ' ' + uri)
}

/**
 * Test-only: forget the session's recorded posts.
 */
export function resetRecorderForTests() {
  recorded.clear()
}
