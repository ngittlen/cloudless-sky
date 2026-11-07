import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a} from '#/alf'
import {Button, ButtonIcon} from '#/components/Button'
import {Eye_Stroke2_Corner0_Rounded as EyeIcon} from '#/components/icons/Eye'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {useSeenFeed} from './context'
import {useToggleHideSeen} from './useToggleHideSeen'

/**
 * Whether the Home header shows the eye button: only while the Following
 * tab is selected, and only inside the Home screen that hides seen posts.
 */
export function useShowSeenToggle(
  selectedFeed: {uri: string} | undefined,
): boolean {
  const {did, anchorRows} = useSeenFeed()
  return !!did && !!anchorRows && selectedFeed?.uri === 'following'
}

/**
 * The eye button that shows or hides seen posts in Following. Its icon and
 * label name the action it takes.
 */
export function SeenToggle() {
  const {t: l} = useLingui()
  const {hideSeen, toggle} = useToggleHideSeen()
  return (
    <Button
      testID="cloudlessSeenToggle"
      label={hideSeen ? l`Show seen posts` : l`Hide seen posts`}
      size="small"
      variant="ghost"
      color="secondary"
      shape="square"
      onPress={toggle}
      style={[a.justify_center, a.bg_transparent]}>
      <ButtonIcon icon={hideSeen ? EyeIcon : EyeSlashIcon} size="lg" />
    </Button>
  )
}

/**
 * {@link SeenToggle} placed just left of the Home header's feeds button,
 * without taking up layout space, so the logo stays centered.
 *
 * - `mobile`: rendered inside the header slot that holds the feeds button.
 * - `desktop`: rendered in the header row just before the feeds button.
 */
export function HomeHeaderSeenToggle({layout}: {layout: 'mobile' | 'desktop'}) {
  if (layout === 'mobile') {
    return (
      <View
        style={[
          a.absolute,
          a.justify_center,
          {top: 0, bottom: 0, right: '100%'},
        ]}>
        <SeenToggle />
      </View>
    )
  }
  return (
    <View style={[a.self_stretch, {width: 0}]}>
      <View
        style={[
          a.absolute,
          a.justify_center,
          {top: 0, bottom: 0, right: a.gap_2xs.gap},
        ]}>
        <SeenToggle />
      </View>
    </View>
  )
}
