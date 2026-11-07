/*
 * Syncs the active account's seen list with the Cloudless Sky sync service
 * (Story 4.2). `SeenFeedProvider` starts it for the signed-in account.
 */
import {logger} from '#/logger'
import {getSeenLists} from '#/features/cloudless/seen/seenList'
import {createSyncClient} from './client'
import {getSyncBaseUrl} from './config'
import {SeenSyncer, type SyncLog, withoutLock} from './SeenSyncer'

type LockManager = {
  request<T>(
    name: string,
    options: {signal: AbortSignal},
    fn: () => Promise<T>,
  ): Promise<T>
}

function getLockManager(): LockManager | undefined {
  try {
    const locks = (globalThis.navigator as {locks?: LockManager} | undefined)
      ?.locks
    return typeof locks?.request === 'function' ? locks : undefined
  } catch {
    return undefined
  }
}

/**
 * Dev builds log every sync so it can be followed in the console.
 */
const log: SyncLog = (message, data) => {
  if (__DEV__) logger.info(`[cloudless] seen sync: ${message}`, data)
}

let active: {stop: () => void} | undefined

/**
 * Starts syncing `did`'s seen list, stopping any other account's sync in
 * this tab. Returns the function that stops it. Does nothing where sync is
 * off (see `getSyncBaseUrl`) or outside a browser.
 */
export function startSeenSync(did: string): () => void {
  const baseUrl = getSyncBaseUrl()
  if (
    !baseUrl ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function' ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return () => {}
  }
  active?.stop()

  const locks = getLockManager()
  const syncer = new SeenSyncer(getSeenLists().get(did), {
    client: createSyncClient(baseUrl),
    isVisible: () => document.visibilityState === 'visible',
    withLock: locks
      ? (name, signal, fn) => locks.request(name, {signal}, fn)
      : withoutLock,
    log,
  })

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') syncer.resume()
    else syncer.pushOnHide()
  }
  const onPageHide = () => syncer.pushOnHide()
  const onOnline = () => syncer.resume()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('online', onOnline)
  syncer.start()

  const handle = {
    stop() {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      syncer.stop()
      if (active === handle) active = undefined
    },
  }
  active = handle
  return handle.stop
}
