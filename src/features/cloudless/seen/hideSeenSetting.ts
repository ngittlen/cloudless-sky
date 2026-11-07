import {Storage} from '#/storage'

/**
 * Where the show/hide seen posts choice is kept. Device-wide, not synced.
 */
export type HideSeenSettingStore = {
  /**
   * The saved choice, or `undefined` when there is none.
   */
  load(): boolean | undefined
  save(value: boolean): void
}

/**
 * Whether Following hides seen posts when nothing has been saved.
 */
export const HIDE_SEEN_DEFAULT = true

type DeviceSchema = {
  hideSeen: boolean
}

/**
 * The fork's own device store, kept apart from upstream's `device` store so
 * its schema file stays unchanged. On web it is backed by `localStorage`.
 */
export function createDeviceHideSeenStore(): HideSeenSettingStore {
  let storage: Storage<[], DeviceSchema> | undefined
  const getStorage = () => {
    storage ??= new Storage<[], DeviceSchema>({id: 'cloudless_device'})
    return storage
  }
  return {
    load() {
      const value = getStorage().get(['hideSeen'])
      return typeof value === 'boolean' ? value : undefined
    },
    save(value) {
      getStorage().set(['hideSeen'], value)
    },
  }
}

/**
 * A store that keeps the choice in memory only.
 */
export function createMemoryHideSeenStore(
  initial?: boolean,
): HideSeenSettingStore {
  let value = initial
  return {
    load: () => value,
    save(next) {
      value = next
    },
  }
}

/**
 * Reads the saved choice. Unreadable storage or a malformed value gives the
 * default, so the feature works without storage.
 */
export function loadHideSeen(store: HideSeenSettingStore): boolean {
  try {
    return store.load() ?? HIDE_SEEN_DEFAULT
  } catch {
    return HIDE_SEEN_DEFAULT
  }
}

/**
 * Saves the choice. A failed write keeps the choice for this session only.
 */
export function saveHideSeen(store: HideSeenSettingStore, value: boolean) {
  try {
    store.save(value)
  } catch {}
}
