import {useMemo} from 'react'

import {type FeedTunerFn} from '#/lib/api/feed-manip'
import {useSeenFeed} from './context'
import {getSeenSnapshotTime} from './feedState'
import {getSeenLists, type SeenList, type SeenListRegistry} from './seenList'

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
 * A Following tuner that drops units seen as of the snapshot time.
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
    return slices.filter(slice => !isSliceSeenAsOf(slice, list, asOf))
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

/**
 * The hiding tuner for Following, or `undefined` when hiding is off. Its
 * identity changes only with the account, the snapshot time and the
 * `hideSeen` flag, and a new identity makes the feed re-tune its loaded
 * pages.
 */
export function useHideSeenTuner(): FeedTunerFn | undefined {
  const {did, snapshotTime, hideSeen} = useSeenFeed()
  return useMemo(
    () =>
      did && hideSeen ? createHideSeenTuner(did, snapshotTime) : undefined,
    [did, hideSeen, snapshotTime],
  )
}
