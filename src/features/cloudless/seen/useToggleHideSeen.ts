import {type InfiniteData, useQueryClient} from '@tanstack/react-query'

import {type FeedPageUnselected, RQKEY_ROOT} from '#/state/queries/post-feed'
import {useShellLayout} from '#/state/shell/shell-layout'
import {useHomeHeaderMode} from '#/view/com/util/MainScrollProvider'
import {useBreakpoints} from '#/alf'
import {useSeenFeed} from './context'
import {getHideSeen, switchHideSeen} from './feedState'
import {restoreSavedCursor} from './SeenFilteringFeedAPI'

/**
 * The show/hide seen posts switch for Following, shared by the Home header
 * button and the "caught up" message. Switching keeps the post the reader is
 * looking at in place:
 *
 * 1. it records the post being read (see `chooseScrollAnchor`);
 * 2. it moves the snapshot to now, so every post seen so far is hidden, or
 *    carries a "Seen" badge while seen posts are shown;
 * 3. switching to showing puts the cursor that hiding held back onto the
 *    last loaded page, so loading carries on past the look-back limit;
 * 4. it flips the setting, which re-tunes the cached pages without a
 *    network request, and `SeenFeedProvider` scrolls the recorded post back
 *    into place once the feed has re-rendered.
 */
export function useToggleHideSeen(): {
  hideSeen: boolean
  toggle: () => void
} {
  const {did, hideSeen, anchorRows} = useSeenFeed()
  const queryClient = useQueryClient()
  const {headerHeight} = useShellLayout()
  const headerMode = useHomeHeaderMode()
  const {gtMobile} = useBreakpoints()

  const toggle = () => {
    if (!did) return
    const hide = !getHideSeen()
    /*
     * Wider layouts keep the tab bar stuck to the top. The phone-width
     * header slides away while scrolling down; `headerMode` is how far.
     */
    const headerBottom = gtMobile
      ? headerHeight.get()
      : headerHeight.get() * (1 - headerMode.get())
    anchorRows?.capture(headerBottom)
    if (!hide) {
      queryClient.setQueriesData<InfiniteData<FeedPageUnselected>>(
        {queryKey: [RQKEY_ROOT, 'following']},
        restoreSavedCursor,
      )
    }
    switchHideSeen(did, hide, Date.now())
  }

  return {hideSeen, toggle}
}
