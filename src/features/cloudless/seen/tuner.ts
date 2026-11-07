import {type FeedTunerFn} from '#/lib/api/feed-manip'
import {getSeenSnapshotTime} from './feedState'
import {isBeforeLookBack} from './lookBack'
import {getSeenLists, type SeenList, type SeenListRegistry} from './seenList'

/**
 * The part of a feed unit the seen check reads, shared by the tuner's slices
 * and the feed's rendered slices.
 */
type SliceLike = {items: {post: {uri: string}}[]}

const hideSeenTuners = new WeakSet<FeedTunerFn>()

/**
 * Whether a feed unit counts as seen for hiding: its last item, the newest
 * post in the unit, was known seen at or before `asOf`. An unseen reply keeps
 * its parent and root even when those were seen, a seen reply goes with its
 * context, and a repost matches the post it carries.
 */
export function isSliceSeenAsOf(
  slice: SliceLike,
  list: SeenList,
  asOf: number,
): boolean {
  const last = slice.items[slice.items.length - 1]
  return !!last && list.isSeenAsOf(last.post.uri, asOf)
}

/**
 * A Following tuner that drops units seen as of the snapshot time, and units
 * that entered the timeline before the look-back limit (the moment the
 * oldest entry known at the snapshot was seen). The second rule covers pages
 * loaded while seen posts were shown.
 *
 * It reads the snapshot time when it runs rather than when it is made: the
 * feed's query sets the snapshot just before it returns the first page, and
 * the query may tune that page before React has re-rendered with a new tuner.
 * `snapshotTime` is the value the tuner was made for, used until the store
 * has one.
 */
export function createHideSeenTuner(
  did: string,
  snapshotTime: number | undefined,
  lists: SeenListRegistry = getSeenLists(),
): FeedTunerFn {
  const tuner: FeedTunerFn = (_tuner, slices) => {
    const asOf = getSeenSnapshotTime(did) ?? snapshotTime
    if (asOf === undefined) return slices
    const list = lists.get(did)
    const lookBack = list.oldestSeenAt(asOf)
    return slices.filter(
      slice =>
        !isSliceSeenAsOf(slice, list, asOf) &&
        (lookBack === undefined ||
          !isBeforeLookBack(slice._feedPost, lookBack)),
    )
  }
  hideSeenTuners.add(tuner)
  return tuner
}

/**
 * Whether `fn` was made by {@link createHideSeenTuner}.
 */
export function isHideSeenTuner(fn: FeedTunerFn): boolean {
  return hideSeenTuners.has(fn)
}
