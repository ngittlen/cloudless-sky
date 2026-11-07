import {logger} from '#/logger'
import {
  SEEN_CHANNEL_NAME,
  SEEN_FLUSH_INTERVAL_MS,
  SEEN_LIST_LIMIT,
} from './constants'
import {
  createIndexedDbStorage,
  getIndexedDbGlobals,
  type SeenEntry,
  type SeenStorage,
} from './db'
import {subscribeToSeen} from './recorder'

/**
 * What this device knows about one seen post.
 */
export type KnownSeen = {
  /**
   * When the post was seen, on any device.
   */
  seenAt: number
  /**
   * When this device learned the post was seen: load time for records read
   * from IndexedDB, write time for new sightings, and receive time for
   * entries from another tab or from sync. Memory only; never stored or
   * synced. Hiding compares it with the feed's snapshot time, so entries
   * learned after a feed loaded never change what is already on screen.
   */
  knownAt: number
}

/**
 * Announces a written batch to the other open tabs.
 */
export type SeenChannelMessage = {
  type: 'written'
  did: string
  entries: SeenEntry[]
  evicted: string[]
}

/**
 * The subset of `BroadcastChannel` the list uses.
 */
export type SeenChannel = {
  postMessage(message: SeenChannelMessage): void
  onmessage: ((event: {data: unknown}) => void) | null
  close(): void
}

export type SeenListDeps = {
  storage: SeenStorage | null
  channel: SeenChannel | null
  now: () => number
  limit: number
  flushIntervalMs: number
  loadTimeoutMs: number
}

/**
 * Consecutive failed writes before the list stops trying to save and keeps
 * the rest of the session in memory.
 */
const MAX_WRITE_FAILURES = 3
const LOAD_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Loading the seen list timed out')),
      ms,
    )
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

function isEntry(value: unknown): value is SeenEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Partial<SeenEntry>
  return (
    typeof e.uri === 'string' &&
    typeof e.seenAt === 'number' &&
    Number.isFinite(e.seenAt)
  )
}

function isChannelMessage(data: unknown): data is SeenChannelMessage {
  if (!data || typeof data !== 'object') return false
  const m = data as Partial<SeenChannelMessage>
  return (
    m.type === 'written' &&
    typeof m.did === 'string' &&
    Array.isArray(m.entries) &&
    Array.isArray(m.evicted)
  )
}

/**
 * One account's seen list: every remembered post in memory, mirrored to
 * IndexedDB in batches. With no storage, or after storage fails, it keeps
 * working in memory for the rest of the session.
 */
export class SeenList {
  readonly did: string
  /**
   * Resolves once stored records are in memory, or loading has given up.
   * Never rejects.
   */
  readonly ready: Promise<void>
  /**
   * Bumped on every change to the entries.
   */
  version = 0

  private deps: SeenListDeps
  private storage: SeenStorage | null
  private entries = new Map<string, KnownSeen>()
  /**
   * Entries waiting to be written, by URI.
   */
  private pending = new Map<string, number>()
  private failures = 0
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> | undefined
  private flushAgain = false
  private disposed = false
  private lookBackCache:
    {version: number; asOf: number; value: number | undefined} | undefined
  /**
   * Posts this tab recorded that the sync service has not confirmed, by URI.
   * With storage, it is this session's share of the `dirty` records, held
   * in memory so a page being hidden can send them without waiting for
   * IndexedDB. Without storage, it is the only record of what to send.
   */
  private unsynced = new Map<string, number>()
  /**
   * The sync position (`lastSyncServerTime`) when there is no storage to
   * keep it in.
   */
  private memorySyncTime: number | undefined
  private addListeners = new Set<() => void>()

  constructor(did: string, deps: SeenListDeps) {
    this.did = did
    this.deps = deps
    this.storage = deps.storage
    this.ready = this.load()
  }

  get size() {
    return this.entries.size
  }

  /**
   * Whether the list is saved to storage, as opposed to memory only.
   */
  get isPersistent() {
    return this.storage !== null
  }

  get(uri: string): KnownSeen | undefined {
    return this.entries.get(uri)
  }

  /**
   * Whether this device knew `uri` was seen at or before `asOf`.
   */
  isSeenAsOf(uri: string, asOf: number): boolean {
    const entry = this.entries.get(uri)
    return !!entry && entry.knownAt <= asOf
  }

  /**
   * The earliest `seenAt` among entries known at or before `asOf`, or
   * `undefined` when there are none. This is the look-back limit.
   */
  oldestSeenAt(asOf: number): number | undefined {
    const cache = this.lookBackCache
    if (cache && cache.version === this.version && cache.asOf === asOf) {
      return cache.value
    }
    let oldest: number | undefined
    for (const entry of this.entries.values()) {
      if (
        entry.knownAt <= asOf &&
        (oldest === undefined || entry.seenAt < oldest)
      ) {
        oldest = entry.seenAt
      }
    }
    this.lookBackCache = {version: this.version, asOf, value: oldest}
    return oldest
  }

  /**
   * Records posts the user has just seen.
   */
  add(uris: string[], seenAt: number) {
    if (this.disposed) return
    const now = this.deps.now()
    for (const uri of uris) {
      this.merge(uri, seenAt, now)
      const queued = this.pending.get(uri)
      if (queued === undefined || queued < seenAt) {
        this.pending.set(uri, seenAt)
      }
      const unsynced = this.unsynced.get(uri)
      if (unsynced === undefined || unsynced < seenAt) {
        this.unsynced.set(uri, seenAt)
      }
    }
    this.version++
    if (!this.storage) {
      this.pending.clear()
      this.enforceLimit()
    } else {
      this.scheduleFlush()
    }
    for (const listener of this.addListeners) listener()
  }

  /**
   * Calls `listener` after every {@link add}. Returns an unsubscribe
   * function.
   */
  onAdd(listener: () => void): () => void {
    this.addListeners.add(listener)
    return () => {
      this.addListeners.delete(listener)
    }
  }

  /**
   * Up to `limit` entries the sync service does not have yet. Pending
   * sightings are written first, so they are included.
   */
  async readUnsynced(limit: number): Promise<SeenEntry[]> {
    await this.ready
    await this.flush()
    const storage = this.storage
    if (storage) return storage.readDirty(this.did, limit)
    return this.peekUnsynced(limit)
  }

  /**
   * Up to `limit` posts this tab recorded and the sync service has not
   * confirmed, newest first, straight from memory.
   */
  peekUnsynced(limit = Infinity): SeenEntry[] {
    const entries: SeenEntry[] = []
    const all = [...this.unsynced]
    for (let i = all.length - 1; i >= 0 && entries.length < limit; i--) {
      entries.push({uri: all[i][0], seenAt: all[i][1]})
    }
    return entries
  }

  /**
   * Records that the sync service accepted `entries`. An entry seen again
   * since it was read stays unsynced.
   */
  async markSynced(entries: SeenEntry[]): Promise<void> {
    for (const entry of entries) {
      if (this.unsynced.get(entry.uri) === entry.seenAt) {
        this.unsynced.delete(entry.uri)
      }
    }
    const storage = this.storage
    if (storage && entries.length > 0) {
      await storage.markSynced(this.did, entries)
    }
  }

  /**
   * The sync service's `serverTime` at the last complete pull, or
   * `undefined` before the first.
   */
  async getSyncTime(): Promise<number | undefined> {
    await this.ready
    const storage = this.storage
    if (!storage) return this.memorySyncTime
    return (await storage.readMeta(this.did))?.lastSyncServerTime
  }

  async setSyncTime(time: number | undefined): Promise<void> {
    const storage = this.storage
    if (!storage) {
      this.memorySyncTime = time
      return
    }
    await storage.writeMeta({did: this.did, lastSyncServerTime: time})
  }

  /**
   * Merges entries pulled from the sync service: stored as synced where new
   * or later, added to memory with `knownAt` set to now (so nothing already
   * on screen changes), trimmed to the limit, and announced to other tabs.
   * Rejects when storage fails, so the pull is retried.
   */
  async applySynced(entries: SeenEntry[]): Promise<void> {
    await this.ready
    if (this.disposed) return
    const valid = entries.filter(isEntry)
    for (const entry of valid) {
      const unsynced = this.unsynced.get(entry.uri)
      // The service holds this sighting or a later one.
      if (unsynced !== undefined && unsynced <= entry.seenAt) {
        this.unsynced.delete(entry.uri)
      }
    }
    const storage = this.storage
    if (storage) {
      const result = await storage.write(this.did, valid, {dirty: 0})
      if (this.disposed) return
      if (result.written.length > 0 || result.evicted.length > 0) {
        const message: SeenChannelMessage = {
          type: 'written',
          did: this.did,
          entries: result.written,
          evicted: result.evicted,
        }
        this.receive(message)
        this.deps.channel?.postMessage(message)
      }
      return
    }
    const now = this.deps.now()
    for (const entry of valid) {
      this.merge(entry.uri, entry.seenAt, now)
    }
    this.version++
    this.enforceLimit()
  }

  /**
   * Writes every pending entry now. Resolves when the write has finished or
   * failed.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true
      return this.flushing
    }
    const run = async () => {
      try {
        do {
          this.flushAgain = false
          await this.flushOnce()
        } while (this.flushAgain && this.pending.size > 0 && this.storage)
      } finally {
        this.flushing = undefined
      }
    }
    this.flushing = run()
    return this.flushing
  }

  /**
   * Applies a batch another tab has written.
   */
  receive(message: SeenChannelMessage) {
    if (this.disposed) return
    const now = this.deps.now()
    for (const entry of message.entries) {
      if (isEntry(entry)) {
        this.merge(entry.uri, entry.seenAt, now)
      }
    }
    this.applyEvictions(message.evicted)
    this.version++
  }

  /**
   * Writes what is pending, then stops. Used when another account becomes
   * active.
   */
  async dispose() {
    await this.flush()
    this.disposed = true
    clearTimeout(this.flushTimer)
    this.entries.clear()
    this.pending.clear()
    this.unsynced.clear()
    this.addListeners.clear()
  }

  private merge(uri: string, seenAt: number, knownAt: number) {
    const existing = this.entries.get(uri)
    if (!existing) {
      this.entries.set(uri, {seenAt, knownAt})
    } else if (existing.seenAt < seenAt) {
      this.entries.set(uri, {seenAt, knownAt: existing.knownAt})
    }
  }

  private applyEvictions(evicted: unknown[]) {
    for (const uri of evicted) {
      // A post seen again after the batch was taken stays.
      if (typeof uri === 'string' && !this.pending.has(uri)) {
        this.entries.delete(uri)
      }
    }
  }

  /**
   * Drops the oldest entries past the limit. Storage enforces the limit on
   * every write; this covers memory-only lists and anything loaded over it.
   */
  private enforceLimit() {
    const excess = this.entries.size - this.deps.limit
    if (excess <= 0) return
    if (excess <= 10) {
      // One sighting at a time past the limit: a scan per entry beats a sort.
      for (let i = 0; i < excess; i++) {
        let oldestUri: string | undefined
        let oldestSeenAt = Infinity
        for (const [uri, entry] of this.entries) {
          if (entry.seenAt < oldestSeenAt) {
            oldestSeenAt = entry.seenAt
            oldestUri = uri
          }
        }
        if (oldestUri !== undefined) this.entries.delete(oldestUri)
      }
    } else {
      const oldest = [...this.entries]
        .sort((a, b) => a[1].seenAt - b[1].seenAt)
        .slice(0, excess)
      for (const [uri] of oldest) {
        this.entries.delete(uri)
      }
    }
    this.version++
  }

  private async load() {
    const storage = this.storage
    if (storage) {
      try {
        const records = await withTimeout(
          storage.load(this.did),
          this.deps.loadTimeoutMs,
        )
        const loadedAt = this.deps.now()
        for (const record of records) {
          this.merge(record.uri, record.seenAt, loadedAt)
        }
      } catch (e) {
        logger.warn('[cloudless] seen list storage unavailable', {
          safeMessage: e,
        })
        this.storage = null
        this.pending.clear()
      }
    }
    this.enforceLimit()
    this.version++
  }

  private scheduleFlush() {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, this.deps.flushIntervalMs)
  }

  private async flushOnce() {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    await this.ready
    const storage = this.storage
    if (!storage || this.pending.size === 0) return

    const batch: SeenEntry[] = []
    for (const [uri, seenAt] of this.pending) {
      batch.push({uri, seenAt})
    }
    this.pending.clear()

    try {
      const result = await storage.write(this.did, batch)
      this.failures = 0
      if (result.evicted.length > 0) {
        this.applyEvictions(result.evicted)
        this.version++
      }
      if (result.written.length > 0 || result.evicted.length > 0) {
        this.deps.channel?.postMessage({
          type: 'written',
          did: this.did,
          entries: result.written,
          evicted: result.evicted,
        })
      }
    } catch (e) {
      this.failures++
      for (const entry of batch) {
        const queued = this.pending.get(entry.uri)
        if (queued === undefined || queued < entry.seenAt) {
          this.pending.set(entry.uri, entry.seenAt)
        }
      }
      if (this.failures >= MAX_WRITE_FAILURES) {
        logger.warn('[cloudless] saving the seen list failed; memory only', {
          safeMessage: e,
        })
        this.storage = null
        this.pending.clear()
        this.enforceLimit()
      } else if (!this.disposed) {
        this.scheduleFlush()
      }
    }
  }
}

/**
 * The seen lists of this tab, one per account, each loaded on first use.
 */
export class SeenListRegistry {
  private lists = new Map<string, SeenList>()
  private deps: SeenListDeps

  constructor(deps: SeenListDeps) {
    this.deps = deps
    if (deps.channel) {
      deps.channel.onmessage = event => {
        if (!isChannelMessage(event.data)) return
        this.lists.get(event.data.did)?.receive(event.data)
      }
    }
  }

  /**
   * The list for `did`, loading it on first use.
   */
  get(did: string): SeenList {
    let list = this.lists.get(did)
    if (!list) {
      list = new SeenList(did, this.deps)
      this.lists.set(did, list)
    }
    return list
  }

  /**
   * Writes out and drops every list but the one for `did`, so a tab that
   * switches accounts keeps one list in memory.
   */
  retainOnly(did: string) {
    for (const [otherDid, other] of this.lists) {
      if (otherDid === did) continue
      this.lists.delete(otherDid)
      void other.dispose()
    }
  }

  /**
   * The list for `did` if it is already in memory.
   */
  peek(did: string): SeenList | undefined {
    return this.lists.get(did)
  }

  flushAll(): Promise<void> {
    return Promise.all([...this.lists.values()].map(l => l.flush())).then(
      () => {},
    )
  }
}

function createChannel(): SeenChannel | null {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(SEEN_CHANNEL_NAME)
      // Node (unit tests) would otherwise keep the process alive.
      ;(channel as {unref?: () => void}).unref?.()
      return channel as SeenChannel
    }
  } catch {}
  return null
}

/**
 * Writes pending entries when the page is hidden or unloaded, so posts seen
 * just before closing the app are kept.
 */
function flushOnHide(registry: SeenListRegistry) {
  if (
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function' ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void registry.flushAll()
    }
  })
  window.addEventListener('pagehide', () => {
    void registry.flushAll()
  })
}

/**
 * Asks the browser not to evict the database under storage pressure.
 */
function requestPersistentStorage() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {})
    }
  } catch {}
}

let registry: SeenListRegistry | undefined

/**
 * The app's seen lists, created on first use.
 */
export function getSeenLists(): SeenListRegistry {
  if (!registry) {
    const globals = getIndexedDbGlobals()
    registry = new SeenListRegistry({
      storage: globals ? createIndexedDbStorage(globals) : null,
      channel: createChannel(),
      now: Date.now,
      limit: SEEN_LIST_LIMIT,
      flushIntervalMs: SEEN_FLUSH_INTERVAL_MS,
      loadTimeoutMs: LOAD_TIMEOUT_MS,
    })
    flushOnHide(registry)
    if (globals) requestPersistentStorage()
  }
  return registry
}

/**
 * Sends every seen event from the recorder to the account's list.
 */
export function connectRecorderToSeenLists() {
  return subscribeToSeen(event => {
    getSeenLists().get(event.did).add(event.uris, event.seenAt)
  })
}
