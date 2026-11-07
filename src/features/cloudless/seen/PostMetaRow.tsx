import {View} from 'react-native'

import {atoms as a} from '#/alf'

/**
 * Lays a post's top line (`PostMeta`) out in a row with `accessory` after
 * it. `PostMeta` keeps `flex: 1`, so it truncates as before and the
 * accessory sits at the end of the line. The row takes `PostMeta`'s
 * `z-index`, keeping the top line's stacking order among the post's parts.
 * Without an accessory the top line renders as it does upstream.
 */
export function PostMetaRow({
  accessory,
  children,
}: {
  accessory?: React.ReactNode
  children: React.ReactNode
}) {
  if (!accessory) return children
  return (
    <View style={[a.flex_row, a.align_center, a.gap_xs, a.z_20]}>
      {children}
      {accessory}
    </View>
  )
}
