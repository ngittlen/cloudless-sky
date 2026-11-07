/*
 * The Following feed's hiding state, outside React so the feed's query
 * function can update it. `SeenFeedProvider` (context.tsx) exposes it to
 * components.
 */

import {
  createDeviceHideSeenStore,
  createMemoryHideSeenStore,
  type HideSeenSettingStore,
  loadHideSeen,
  saveHideSeen,
} from './hideSeenSetting'

type Listener = () => void

/**
 * Per account: posts known seen at or before this time are hidden. It moves
 * only when the Following query fetches its first page (open or refresh) and
 * when the show/hide toggle switches to hiding, so posts seen while
 * scrolling never vanish from a feed that is already on screen.
 */
const snapshotTimes = new Map<string, number>()
let settingStore: HideSeenSettingStore = createDeviceHideSeenStore()
/**
 * Whether Following hides seen posts. Device-wide and remembered across
 * restarts; read from storage on first use.
 */
let hideSeen: boolean | undefined
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
  hideSeen ??= loadHideSeen(settingStore)
  return hideSeen
}

/**
 * Sets and remembers whether Following hides seen posts.
 */
export function setHideSeen(value: boolean) {
  if (getHideSeen() === value) return
  hideSeen = value
  saveHideSeen(settingStore, value)
  notify()
}

/**
 * Switches between hiding and showing seen posts, for the show/hide toggle.
 * Switching to hiding moves the snapshot to `now` in the same update, so the
 * feed is re-tuned once and hides every post seen so far, including those
 * seen while seen posts were shown.
 */
export function switchHideSeen(
  did: string | undefined,
  hide: boolean,
  now: number,
) {
  const current = did ? snapshotTimes.get(did) : undefined
  if (hide && did && (current === undefined || current < now)) {
    snapshotTimes.set(did, now)
  }
  hideSeen = hide
  saveHideSeen(settingStore, hide)
  notify()
}

/**
 * Test-only: back to the defaults. `store` stands in for the device's
 * storage; the remembered choice is read from it on next use.
 */
export function resetSeenFeedStateForTests(
  store: HideSeenSettingStore = createMemoryHideSeenStore(),
) {
  snapshotTimes.clear()
  settingStore = store
  hideSeen = undefined
  notify()
}
