import {FALLBACK_MARKER_POST} from '#/lib/api/feed/home'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'

/**
 * When a feed item entered the timeline, in milliseconds: the repost time for
 * a repost, the post's index time otherwise. `undefined` for items that are
 * not from the timeline (posts mixed in from custom feeds by the merged "lab"
 * Following feed) or that have no readable time.
 */
export function getFeedItemSortTime(
  item: app.bsky.feed.defs.FeedViewPost,
): number | undefined {
  if ('__source' in item) return undefined
  const time = bsky.isType(app.bsky.feed.defs.reasonRepost, item.reason)
    ? item.reason.indexedAt
    : item.post.indexedAt
  const ms = Date.parse(time)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Whether the item entered the timeline before the look-back limit.
 */
export function isBeforeLookBack(
  item: app.bsky.feed.defs.FeedViewPost,
  lookBack: number,
): boolean {
  const time = getFeedItemSortTime(item)
  return time !== undefined && time < lookBack
}

/**
 * The marker Home's Following feed inserts when the timeline runs out and it
 * falls back to Discover.
 */
export function isFallbackMarker(item: app.bsky.feed.defs.FeedViewPost) {
  return item.post.uri === FALLBACK_MARKER_POST.post.uri
}
