/*
 * The Following feed's hiding state, outside React so the feed's query
 * function can update it. `SeenFeedProvider` (context.tsx) exposes it to
 * components.
 */

type Listener = () => void

/**
 * Per account: posts known seen at or before this time are hidden. It moves
 * only when the Following query fetches its first page (open or refresh) and
 * when the show/hide toggle switches to hiding, so posts seen while
 * scrolling never vanish from a feed that is already on screen.
 */
const snapshotTimes = new Map<string, number>()
/**
 * Whether Following hides seen posts. Device-wide.
 */
let hideSeen = true
const listeners = new Set<Listener>()

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeToSeenFeedState(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSeenSnapshotTime(did: string): number | undefined {
  return snapshotTimes.get(did)
}

/**
 * Sets the snapshot time for `did`. Never moves it backwards, so a slow
 * request that finishes after a newer one cannot unhide posts.
 */
export function setSeenSnapshotTime(did: string, time: number) {
  const current = snapshotTimes.get(did)
  if (current !== undefined && current >= time) return
  snapshotTimes.set(did, time)
  notify()
}

export function getHideSeen(): boolean {
  return hideSeen
}

export function setHideSeen(value: boolean) {
  if (hideSeen === value) return
  hideSeen = value
  notify()
}

/**
 * Test-only: back to the defaults.
 */
export function resetSeenFeedStateForTests() {
  snapshotTimes.clear()
  hideSeen = true
  notify()
}
