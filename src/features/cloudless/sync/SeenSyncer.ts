import {type SeenList} from '#/features/cloudless/seen/seenList'
import {
  fitKeepaliveBatch,
  isSendable,
  type SyncClient,
  SyncHttpError,
} from './client'
import {
  KEEPALIVE_MAX_BYTES,
  MAX_PULL_PAGES,
  MAX_PUSH_BATCHES,
  PUSH_BATCH_SIZE,
  PUSH_DELAY_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SYNC_INTERVAL_MS,
} from './constants'

export type SyncLog = (message: string, data?: Record<string, unknown>) => void

export type SeenSyncerDeps = {
  client: SyncClient
  /**
   * Whether the page is visible. Timed syncs run only while it is.
   */
  isVisible: () => boolean
  /**
   * Runs `fn` while holding the lock `name`, shared by this browser's tabs,
   * so two tabs never sync one account at the same time. Gives up waiting
   * when `signal` aborts.
   */
  withLock: <T>(
    name: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ) => Promise<T>
  log: SyncLog
  intervalMs?: number
  pushDelayMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  keepaliveMaxBytes?: number
}

class SyncStoppedError extends Error {
  constructor() {
    super('Sync stopped')
    this.name = 'SyncStoppedError'
  }
}

/**
 * Runs `fn` directly, for environments without a cross-tab lock.
 */
export function withoutLock<T>(
  _name: string,
  _signal: AbortSignal,
  fn: () => Promise<T>,
) {
  return fn()
}

/**
 * Keeps one account's seen list in step with the sync service (Story 4.1).
 *
 * - A full sync pulls every change since the last complete pull, merges it
 *   into the list ({@link SeenList.applySynced}), saves the new position,
 *   then pushes every entry the service does not have yet.
 * - It runs once the list has loaded, every 30 seconds while the page is
 *   visible, and when the page becomes visible again. A push alone runs a
 *   few seconds after the user sees new posts, and a keepalive push sends
 *   what it can while the page is being hidden.
 * - After a failure it retries with exponential backoff, capped at a few
 *   minutes. Nothing waits on it: the feed reads the list whether or not a
 *   sync has run.
 *
 * Merged entries are known from the moment they arrive, after the feed's
 * snapshot, so they change nothing on screen until the next refresh or
 * toggle.
 */
export class SeenSyncer {
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private pushTimer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private running: Promise<void> | undefined
  private queued: {pull: boolean} | undefined
  private keepaliveInFlight = false
  private abort = new AbortController()
  private unsubscribeAdd: (() => void) | undefined
  private intervalMs: number
  private pushDelayMs: number
  private retryBaseMs: number
  private retryMaxMs: number
  private keepaliveMaxBytes: number

  constructor(
    readonly list: SeenList,
    private deps: SeenSyncerDeps,
  ) {
    this.intervalMs = deps.intervalMs ?? SYNC_INTERVAL_MS
    this.pushDelayMs = deps.pushDelayMs ?? PUSH_DELAY_MS
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS
    this.retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS
    this.keepaliveMaxBytes = deps.keepaliveMaxBytes ?? KEEPALIVE_MAX_BYTES
  }

  get did() {
    return this.list.did
  }

  /**
   * Starts syncing once the list has loaded.
   */
  start() {
    this.unsubscribeAdd = this.list.onAdd(() => this.schedulePush())
    void this.list.ready.then(() => {
      if (!this.stopped) void this.sync({pull: true})
    })
  }

  /**
   * Stops every timer and abandons requests in flight. Used on sign-out and
   * when another account becomes active.
   */
  stop() {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.pushTimer)
    this.timer = undefined
    this.pushTimer = undefined
    this.abort.abort()
    this.unsubscribeAdd?.()
  }

  /**
   * The page became visible or the network came back: sync now, without
   * waiting out a retry delay.
   */
  resume() {
    if (this.stopped) return
    void this.sync({pull: true})
  }

  /**
   * The page is being hidden or unloaded. Sends the newest sightings that
   * fit in one keepalive request, straight from memory, since there may be
   * no time to read IndexedDB. Anything left stays unsynced for next time.
   */
  pushOnHide() {
    if (this.stopped || this.keepaliveInFlight) return
    clearTimeout(this.pushTimer)
    this.pushTimer = undefined
    const entries = fitKeepaliveBatch(
      this.did,
      this.list.peekUnsynced(PUSH_BATCH_SIZE).filter(isSendable),
      this.keepaliveMaxBytes,
    )
    if (entries.length === 0) return
    this.keepaliveInFlight = true
    this.deps.client
      .pushKeepalive(this.did, entries)
      .then(() => this.list.markSynced(entries))
      .then(
        () =>
          this.deps.log('pushed on hide', {
            did: this.did,
            sent: entries.length,
          }),
        (e: unknown) =>
          this.deps.log('push on hide failed', {did: this.did, error: e}),
      )
      .finally(() => {
        this.keepaliveInFlight = false
      })
  }

  /**
   * Pulls (when `pull` is set) and pushes. A call while a sync is running
   * runs once more after it, so the latest sightings are not left behind.
   * Resolves when this call's sync has finished or failed; never rejects.
   */
  sync({pull}: {pull: boolean}): Promise<void> {
    if (this.running) {
      this.queued = {pull: pull || !!this.queued?.pull}
      return this.running
    }
    const run = this.runOnce(pull).finally(() => {
      this.running = undefined
      const next = this.queued
      this.queued = undefined
      if (next && !this.stopped) void this.sync(next)
    })
    this.running = run
    return run
  }

  private schedulePush() {
    // While retrying, the retry timer pushes.
    if (this.stopped || this.pushTimer !== undefined || this.failures > 0) {
      return
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined
      void this.sync({pull: false})
    }, this.pushDelayMs)
  }

  private scheduleNext(delayMs: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      // A hidden page waits; becoming visible syncs at once.
      if (this.deps.isVisible()) void this.sync({pull: true})
    }, delayMs)
  }

  private throwIfStopped() {
    if (this.stopped) throw new SyncStoppedError()
  }

  private async runOnce(pull: boolean) {
    if (pull) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    try {
      const result = await this.deps.withLock(
        `cloudless_seen_sync:${this.did}`,
        this.abort.signal,
        async () => {
          const received = pull ? await this.pull() : undefined
          const sent = await this.push()
          return {received, sent}
        },
      )
      if (this.stopped) return
      this.failures = 0
      this.deps.log('synced', {did: this.did, ...result})
      /*
       * A push alone leaves the next pull where it is, so a device whose
       * user keeps seeing posts still pulls every interval.
       */
      if (pull || this.timer === undefined) this.scheduleNext(this.intervalMs)
    } catch (e) {
      if (this.stopped) return
      this.failures++
      const retryInMs = Math.min(
        this.retryBaseMs * 2 ** (this.failures - 1),
        this.retryMaxMs,
      )
      this.deps.log('sync failed', {
        did: this.did,
        error: e,
        failures: this.failures,
        retryInMs,
      })
      this.scheduleNext(retryInMs)
    }
  }

  /**
   * Fetches every change since the last complete pull and merges it. The
   * position moves only once the last page is merged, so an interrupted
   * pull starts over from the same place.
   */
  private async pull(): Promise<{entries: number; pages: number}> {
    let since = await this.list.getSyncTime()
    let cursor: string | undefined
    let pages = 0
    let entries = 0
    let serverTime: number
    for (;;) {
      this.throwIfStopped()
      let page
      try {
        page = await this.deps.client.pull(
          this.did,
          {since, cursor},
          this.abort.signal,
        )
      } catch (e) {
        /*
         * The service rejects a position it could not have issued, as after
         * its database is replaced. Starting over fetches the whole list,
         * which merging makes harmless.
         */
        if (
          e instanceof SyncHttpError &&
          e.status === 400 &&
          since !== undefined &&
          cursor === undefined
        ) {
          since = undefined
          continue
        }
        throw e
      }
      this.throwIfStopped()
      await this.list.applySynced(page.entries)
      pages++
      entries += page.entries.length
      serverTime = page.serverTime
      if (!page.cursor) break
      if (pages >= MAX_PULL_PAGES) {
        throw new Error('The sync service kept sending pages')
      }
      cursor = page.cursor
    }
    this.throwIfStopped()
    await this.list.setSyncTime(serverTime)
    return {entries, pages}
  }

  /**
   * Sends every entry the service does not have, a batch at a time,
   * marking each batch synced once the service accepts it.
   */
  private async push(): Promise<number> {
    let sent = 0
    for (let i = 0; i < MAX_PUSH_BATCHES; i++) {
      this.throwIfStopped()
      const batch = await this.list.readUnsynced(PUSH_BATCH_SIZE)
      if (batch.length === 0) break
      const sendable = batch.filter(isSendable)
      if (sendable.length > 0) {
        await this.deps.client.push(this.did, sendable, this.abort.signal)
      }
      // Entries the service would reject are marked too, so they never block.
      await this.list.markSynced(batch)
      sent += sendable.length
      if (batch.length < PUSH_BATCH_SIZE) break
    }
    return sent
  }
}
