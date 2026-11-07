import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {useSeenFeed} from './context'
import {getSeenLists, type SeenList} from './seenList'
import {isSliceSeenAsOf} from './tuner'

/**
 * A small "Seen" pill for the top line of a seen post while seen posts are
 * shown. It never shrinks; the post's name and handle truncate around it.
 */
export function SeenBadge() {
  const t = useTheme()
  return (
    <View
      testID="cloudlessSeenBadge"
      style={[
        a.flex_shrink_0,
        a.mb_xs,
        a.px_xs,
        a.rounded_full,
        t.atoms.bg_contrast_50,
      ]}>
      <Text
        style={[
          a.text_2xs,
          a.font_semi_bold,
          a.leading_snug,
          t.atoms.text_contrast_medium,
        ]}>
        <Trans context="Badge on a post the user has already seen">Seen</Trans>
      </Text>
    </View>
  )
}

/**
 * One element for every badge, so a post row's memoized parts see the same
 * prop from one render to the next.
 */
const SEEN_BADGE = <SeenBadge />

type SliceLike = Parameters<typeof isSliceSeenAsOf>[0]

/**
 * What decides the badges: the badge marks exactly the units that hiding
 * would hide, as of the same snapshot.
 */
export type SeenBadgeState = {
  feed: string
  hideSeen: boolean
  snapshotTime: number | undefined
  list: SeenList | undefined
}

/**
 * Whether a unit's posts get a "Seen" badge: only in Following, only while
 * seen posts are shown, and only when the unit's last post was known seen at
 * or before the snapshot. Every post in a unit gets the same answer.
 */
export function shouldShowSeenBadge(
  {feed, hideSeen, snapshotTime, list}: SeenBadgeState,
  slice: SliceLike,
): boolean {
  if (feed !== 'following' || hideSeen) return false
  if (snapshotTime === undefined || !list) return false
  return isSliceSeenAsOf(slice, list, snapshotTime)
}

function noBadge(_slice: SliceLike): React.ReactNode {
  return undefined
}

/**
 * For `PostFeed`: the `metaAccessory` for a unit's post rows, which is the
 * "Seen" badge or nothing. Outside Home's Following feed it never badges.
 */
export function useSeenBadgeFor(
  feed: string,
): (slice: SliceLike) => React.ReactNode {
  const {did, hideSeen, snapshotTime} = useSeenFeed()
  if (feed !== 'following' || !did || hideSeen) return noBadge
  /*
   * The list is looked up per row rather than once per render: it may not
   * exist yet on the first render, and a value read here would be memoized
   * for as long as the account stays the same.
   */
  return slice =>
    shouldShowSeenBadge(
      {feed, hideSeen, snapshotTime, list: getSeenLists().peek(did)},
      slice,
    )
      ? SEEN_BADGE
      : undefined
}
