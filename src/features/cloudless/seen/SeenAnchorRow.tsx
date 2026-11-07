import {type ListRenderItemInfo, View} from 'react-native'

import {getAnchorRowId, type SeenAnchorRows} from './anchor'
import {useSeenFeed} from './context'

/**
 * The parts of a feed row this module reads. `PostFeed` keeps its row type
 * private, so this matches it by shape.
 */
type FeedRowLike = {
  type: string
}

type SliceItemRowLike = {
  type: 'sliceItem'
  slice: {_reactKey: string; items: {uri: string}[]}
  indexInSlice: number
}

function isSliceItemRow(row: FeedRowLike): row is SliceItemRowLike {
  return row.type === 'sliceItem'
}

/**
 * The anchor identity of a feed row, or `undefined` for rows that are not
 * posts.
 */
export function getFeedRowAnchorId(row: FeedRowLike): string | undefined {
  if (!isSliceItemRow(row)) return undefined
  const item = row.slice.items[row.indexInSlice]
  return item ? getAnchorRowId(row.slice._reactKey, item.uri) : undefined
}

/**
 * Wraps `renderItem` so the Following feed's post rows register with the
 * show/hide toggle, which measures them to keep the reader's place. Other
 * feeds, and Following outside Home, get `renderItem` back unchanged.
 */
export function useSeenAnchorRenderItem<Row extends FeedRowLike>(
  feed: string,
  renderItem: (info: ListRenderItemInfo<Row>) => React.ReactNode,
): (info: ListRenderItemInfo<Row>) => React.ReactNode {
  const {anchorRows} = useSeenFeed()
  if (feed !== 'following' || !anchorRows) return renderItem
  return info => {
    const id = getFeedRowAnchorId(info.item)
    const node = renderItem(info)
    if (id === undefined) return node
    return (
      <SeenAnchorRow id={id} rows={anchorRows}>
        {node}
      </SeenAnchorRow>
    )
  }
}

function SeenAnchorRow({
  id,
  rows,
  children,
}: {
  id: string
  rows: SeenAnchorRows
  children: React.ReactNode
}) {
  return <View ref={node => rows.register(id, node)}>{children}</View>
}
