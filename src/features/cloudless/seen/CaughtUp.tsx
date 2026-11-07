import {View} from 'react-native'
import {Trans} from '@lingui/react/macro'

import {FollowingEmptyState} from '#/view/com/posts/FollowingEmptyState'
import {FollowingEndOfFeed} from '#/view/com/posts/FollowingEndOfFeed'
import {atoms as a, useTheme} from '#/alf'
import {CircleCheck_Stroke2_Corner0_Rounded as CircleCheckIcon} from '#/components/icons/CircleCheck'
import {Text} from '#/components/Typography'
import {useSeenFeed} from './context'
import {getSeenLists} from './seenList'

/**
 * The end of Following while seen posts are hidden: everything new has been
 * seen.
 */
export function CaughtUp() {
  const t = useTheme()
  return (
    <View
      testID="cloudlessCaughtUp"
      style={[a.align_center, a.gap_md, a.px_xl, a.py_5xl]}>
      <CircleCheckIcon size="2xl" style={t.atoms.text_contrast_medium} />
      <Text style={[a.text_xl, a.font_bold, a.text_center, t.atoms.text]}>
        <Trans>You’re all caught up</Trans>
      </Text>
      <Text
        style={[
          a.text_md,
          a.leading_snug,
          a.text_center,
          t.atoms.text_contrast_medium,
        ]}>
        <Trans>You’ve seen every new post from the people you follow.</Trans>
      </Text>
    </View>
  )
}

/**
 * Whether the end of Following means "caught up": seen posts are hidden and
 * the account has seen something as of the snapshot. With an empty seen list
 * nothing is hidden, so the official messages apply.
 */
export function useIsCaughtUpMode(): boolean {
  const {did, snapshotTime, hideSeen} = useSeenFeed()
  if (!did || !hideSeen || snapshotTime === undefined) return false
  return getSeenLists().peek(did)?.oldestSeenAt(snapshotTime) !== undefined
}

/**
 * Following's empty state: "caught up" while seen posts are hidden, the
 * official message otherwise.
 */
export function FollowingEmptyStateOrCaughtUp() {
  return useIsCaughtUpMode() ? <CaughtUp /> : <FollowingEmptyState />
}

/**
 * Following's end-of-feed state: "caught up" while seen posts are hidden, the
 * official message otherwise.
 */
export function FollowingEndOfFeedOrCaughtUp() {
  return useIsCaughtUpMode() ? <CaughtUp /> : <FollowingEndOfFeed />
}

/**
 * For `FeedPage`'s `renderEndOfFeed`, which is called as a function.
 */
export function renderFollowingEndOfFeed() {
  return <FollowingEndOfFeedOrCaughtUp />
}
