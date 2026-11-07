/*
 * Keeps the reader's place when the show/hide toggle adds or removes seen
 * posts. Browsers' own scroll anchoring (CSS `overflow-anchor`) is not
 * available in every Safari, so the feed measures a post before the switch
 * and scrolls it back to the same place after.
 */

/**
 * A post row's identity and its edges relative to the viewport.
 */
export type RowPosition = {
  id: string
  top: number
  bottom: number
}

/**
 * The post the reader was looking at when the toggle switched.
 */
export type ScrollAnchor = {
  /**
   * The anchor row's identity.
   */
  id: string
  /**
   * Its top edge relative to the viewport before the switch.
   */
  top: number
  /**
   * Every row's identity in screen order before the switch, to find the
   * nearest remaining row when the anchor itself is hidden.
   */
  order: string[]
  /**
   * The anchor's index in `order`.
   */
  index: number
}

/**
 * A stable identity for a post row in the Following feed: its unit and the
 * post. Row keys from the feed include the post's position in the unit,
 * which can differ between hiding and showing.
 */
export function getAnchorRowId(sliceKey: string, postUri: string) {
  return `${sliceKey}|${postUri}`
}

/**
 * Picks the anchor: the first row whose top is at or below the header's
 * bottom edge. A row that runs under the header is used instead when it
 * fills at least half of the screen below the header, since that is the
 * post being read. When every row is above the header, as at the end of the
 * feed, the last row is used.
 */
export function chooseScrollAnchor(
  rows: RowPosition[],
  headerBottom: number,
  viewportBottom: number,
): ScrollAnchor | undefined {
  if (!rows.length) return undefined
  const sorted = [...rows].sort((a, b) => a.top - b.top)
  const below = sorted.findIndex(row => row.top >= headerBottom)
  const straddling = (below === -1 ? sorted.length : below) - 1
  const visibleHeight = viewportBottom - headerBottom
  let index = below === -1 ? sorted.length - 1 : below
  if (
    straddling >= 0 &&
    sorted[straddling].bottom - headerBottom >= visibleHeight / 2
  ) {
    index = straddling
  }
  return {
    id: sorted[index].id,
    top: sorted[index].top,
    order: sorted.map(row => row.id),
    index,
  }
}

/**
 * The row to keep in place after the switch: the anchor if it is still
 * shown, otherwise the nearest shown row below it, otherwise the nearest
 * shown row above it.
 */
export function findAnchorTarget(
  anchor: ScrollAnchor,
  isShown: (id: string) => boolean,
): string | undefined {
  if (isShown(anchor.id)) return anchor.id
  for (let i = anchor.index + 1; i < anchor.order.length; i++) {
    if (isShown(anchor.order[i])) return anchor.order[i]
  }
  for (let i = anchor.index - 1; i >= 0; i--) {
    if (isShown(anchor.order[i])) return anchor.order[i]
  }
  return undefined
}

type MeasurableNode = {
  isConnected?: boolean
  getBoundingClientRect(): {top: number; height: number}
}

function isMeasurable(node: unknown): node is MeasurableNode {
  return (
    !!node &&
    typeof (node as MeasurableNode).getBoundingClientRect === 'function'
  )
}

/**
 * Scrolls the feed by `delta` pixels.
 */
type ScrollBy = (delta: number) => void

/**
 * Home's feeds scroll the window on web. `scrollTo` rather than `scrollBy`:
 * the shell treats `window.scrollTo` as a programmatic scroll and leaves the
 * phone-width header where it is (`MainScrollProvider`).
 */
function scrollWindowBy(delta: number) {
  window.scrollTo({top: window.scrollY + delta, behavior: 'instant'})
}

function getWindowHeight() {
  return typeof window === 'undefined' ? Infinity : window.innerHeight
}

/**
 * The Following feed's post rows on screen, registered by the feed as they
 * mount. Only web rows can be measured; elsewhere it stays empty.
 */
export class SeenAnchorRows {
  private nodes = new Map<string, MeasurableNode>()
  private pending: ScrollAnchor | undefined
  private resumeAnchoring: (() => void) | undefined
  private scrollBy: ScrollBy
  private pauseAnchoring: () => () => void
  private getViewportHeight: () => number

  constructor({
    scrollBy = scrollWindowBy,
    pauseAnchoring = pauseBrowserScrollAnchoring,
    getViewportHeight = getWindowHeight,
  }: {
    scrollBy?: ScrollBy
    pauseAnchoring?: () => () => void
    getViewportHeight?: () => number
  } = {}) {
    this.scrollBy = scrollBy
    this.pauseAnchoring = pauseAnchoring
    this.getViewportHeight = getViewportHeight
  }

  /**
   * Registers a row's node. Returns the cleanup for a React ref callback.
   */
  register(id: string, node: unknown): () => void {
    if (!isMeasurable(node)) return () => {}
    this.nodes.set(id, node)
    return () => {
      if (this.nodes.get(id) === node) this.nodes.delete(id)
    }
  }

  /**
   * The registered rows that are laid out, with their tops.
   */
  positions(): RowPosition[] {
    const rows: RowPosition[] = []
    for (const [id, node] of this.nodes) {
      if (node.isConnected === false) continue
      const rect = node.getBoundingClientRect()
      // A hidden page (`display: none`) lays out at zero height.
      if (rect.height <= 0) continue
      rows.push({id, top: rect.top, bottom: rect.top + rect.height})
    }
    return rows
  }

  /**
   * Records the anchor before a switch, and pauses the browser's scroll
   * anchoring until the last {@link restore}. `restore` uses the anchor once
   * the feed has re-rendered.
   */
  capture(headerBottom: number) {
    this.pending = chooseScrollAnchor(
      this.positions(),
      headerBottom,
      this.getViewportHeight(),
    )
    if (this.pending) this.resumeAnchoring ??= this.pauseAnchoring()
  }

  /**
   * Scrolls so the recorded anchor, or the nearest row still shown, is back
   * where the anchor was. `keep` leaves the anchor recorded for another pass,
   * for content that settles after the first layout.
   */
  restore({keep = false}: {keep?: boolean} = {}) {
    const anchor = this.pending
    if (!anchor) return
    const shown = new Map(this.positions().map(row => [row.id, row.top]))
    const target = findAnchorTarget(anchor, id => shown.has(id))
    if (target !== undefined) {
      const delta = shown.get(target)! - anchor.top
      if (Math.abs(delta) >= 1) this.scrollBy(delta)
    }
    if (!keep) this.release()
  }

  /**
   * Forgets the recorded anchor and lets the browser anchor again.
   */
  release() {
    this.pending = undefined
    this.resumeAnchoring?.()
    this.resumeAnchoring = undefined
  }
}

/**
 * Pauses the browser's scroll anchoring on the page's scrolling element
 * until the returned function is called. Without this, a browser that
 * anchors would move the page as well when rows are added above the anchor.
 */
export function pauseBrowserScrollAnchoring(): () => void {
  if (typeof document === 'undefined') return () => {}
  const el = document.scrollingElement as HTMLElement | null
  if (!el?.style) return () => {}
  const previous = el.style.getPropertyValue('overflow-anchor')
  el.style.setProperty('overflow-anchor', 'none')
  return () => {
    if (previous) {
      el.style.setProperty('overflow-anchor', previous)
    } else {
      el.style.removeProperty('overflow-anchor')
    }
  }
}
