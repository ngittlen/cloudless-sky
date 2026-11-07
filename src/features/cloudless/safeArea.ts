import {useSafeAreaInsets} from 'react-native-safe-area-context'

/**
 * Bottom padding that keeps the web bottom bar clear of the iPhone home
 * indicator. The home-screen app runs full-screen and the page uses
 * `viewport-fit=cover`, so it reaches the bottom edge of the screen, and the
 * web bar (unlike the native one) has no safe-area padding of its own. The
 * inset is 0 in desktop browsers.
 */
export function useWebBottomBarSafeAreaStyle() {
  const {bottom} = useSafeAreaInsets()
  return {paddingBottom: bottom}
}
