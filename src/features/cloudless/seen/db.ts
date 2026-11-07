import {
  META_STORE,
  SEEN_BY_DIRTY_INDEX,
  SEEN_BY_TIME_INDEX,
  SEEN_DB_NAME,
  SEEN_DB_VERSION,
  SEEN_LIST_LIMIT,
  SEEN_STORE,
  type SeenMeta,
  type SeenRecord,
} from './constants'

/**
 * A seen post without its account, as the in-memory list holds it.
 */
export type SeenEntry = {uri: string; seenAt: number}

export type SeenWriteResult = {
  /**
   * The entries that were new or later than the stored ones, as stored.
   */
  written: SeenEntry[]
  /**
   * URIs dropped by the rolling limit.
   */
  evicted: string[]
}

/**
 * Persistent storage for seen lists. The in-memory list works without one.
 */
export interface SeenStorage {
  load(did: string): Promise<SeenEntry[]>
  write(
    did: string,
    entries: SeenEntry[],
    opts?: {dirty?: 0 | 1},
  ): Promise<SeenWriteResult>
  /**
   * Up to `limit` records not yet sent to the sync service.
   */
  readDirty(did: string, limit: number): Promise<SeenEntry[]>
  /**
   * Marks records as sent, skipping any whose `seenAt` has changed since.
   */
  markSynced(did: string, entries: SeenEntry[]): Promise<void>
  readMeta(did: string): Promise<SeenMeta | undefined>
  writeMeta(meta: SeenMeta): Promise<void>
}

type IndexedDbGlobals = {
  indexedDB: IDBFactory
  IDBKeyRange: typeof IDBKeyRange
}

/**
 * How long to wait for the database to open. Some Safari versions never
 * answer `indexedDB.open`, and the Following feed waits for the list to load.
 */
const OPEN_TIMEOUT_MS = 5_000

/**
 * The browser's IndexedDB, or `undefined` where there is none (native, tests,
 * private modes that block it).
 */
export function getIndexedDbGlobals(): IndexedDbGlobals | undefined {
  try {
    const g = globalThis as Partial<IndexedDbGlobals>
    if (g.indexedDB && g.IDBKeyRange) {
      return {indexedDB: g.indexedDB, IDBKeyRange: g.IDBKeyRange}
    }
  } catch {
    // Accessing indexedDB throws in some sandboxed iframes.
  }
  return undefined
}

/**
 * Opens (and on first use creates) the seen-list database.
 */
export function openSeenDb(
  {indexedDB}: IndexedDbGlobals,
  timeoutMs = OPEN_TIMEOUT_MS,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error('Opening the seen-list database timed out'))
    }, timeoutMs)
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(SEEN_DB_NAME, SEEN_DB_VERSION)
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SEEN_STORE)) {
        const seen = db.createObjectStore(SEEN_STORE, {
          keyPath: ['did', 'uri'],
        })
        seen.createIndex(SEEN_BY_TIME_INDEX, ['did', 'seenAt'])
        seen.createIndex(SEEN_BY_DIRTY_INDEX, ['did', 'dirty'])
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, {keyPath: 'did'})
      }
    }
    req.onsuccess = () => {
      const db = req.result
      if (settled) {
        // The open finished after the timeout gave up on it.
        db.close()
        return
      }
      // Let a newer schema in another tab upgrade instead of blocking it.
      db.onversionchange = () => db.close()
      finish(() => resolve(db))
    }
    req.onerror = () => {
      finish(() =>
        reject(req.error ?? new Error('Opening the seen-list database failed')),
      )
    }
    req.onblocked = () => {
      finish(() => reject(new Error('Opening the seen-list database blocked')))
    }
  })
}

function isValidRecord(value: unknown): value is SeenRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<SeenRecord>
  return (
    typeof r.uri === 'string' &&
    typeof r.seenAt === 'number' &&
    Number.isFinite(r.seenAt)
  )
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () =>
      reject(tx.error ?? new Error('Seen-list transaction aborted'))
    tx.onerror = () =>
      reject(tx.error ?? new Error('Seen-list transaction failed'))
  })
}

/**
 * Every stored entry for `did`. Records that cannot be read are skipped.
 */
export async function loadSeen(
  db: IDBDatabase,
  {IDBKeyRange}: IndexedDbGlobals,
  did: string,
): Promise<SeenEntry[]> {
  const tx = db.transaction(SEEN_STORE, 'readonly')
  const done = txDone(tx)
  const req = tx
    .objectStore(SEEN_STORE)
    // Every `[did, uri]` key sorts between `[did]` and `[did, []]`.
    .getAll(IDBKeyRange.bound([did], [did, []]))
  await done
  const entries: SeenEntry[] = []
  for (const value of req.result as unknown[]) {
    if (isValidRecord(value)) {
      entries.push({uri: value.uri, seenAt: value.seenAt})
    }
  }
  return entries
}

/**
 * Writes a batch in one transaction, keeping the later `seenAt` for posts
 * already stored, then drops the oldest records past
 * {@link SEEN_LIST_LIMIT}. Tabs that write at the same time are serialized by
 * IndexedDB, so the later `seenAt` wins whichever tab writes last.
 *
 * `dirty: 0` writes entries the sync service already holds. A stored record
 * with a later `seenAt` keeps it and stays dirty, so it is still sent; one
 * with the same `seenAt` is marked synced, since the service has it.
 */
export async function writeSeen(
  db: IDBDatabase,
  {IDBKeyRange}: IndexedDbGlobals,
  did: string,
  entries: SeenEntry[],
  {dirty = 1, limit = SEEN_LIST_LIMIT}: {dirty?: 0 | 1; limit?: number} = {},
): Promise<SeenWriteResult> {
  const written: SeenEntry[] = []
  const evicted: string[] = []
  const tx = db.transaction(SEEN_STORE, 'readwrite')
  const done = txDone(tx)
  const store = tx.objectStore(SEEN_STORE)
  const byTime = store.index(SEEN_BY_TIME_INDEX)
  const didRange = IDBKeyRange.bound([did, -Infinity], [did, Infinity])

  /*
   * Requests in a transaction run in the order they are made, so the count
   * is requested only after the last put has been queued.
   */
  const trim = () => {
    const countReq = byTime.count(didRange)
    countReq.onsuccess = () => {
      let excess = countReq.result - limit
      if (excess <= 0) return
      const cursorReq = byTime.openCursor(didRange)
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor || excess <= 0) return
        evicted.push((cursor.primaryKey as [string, string])[1])
        cursor.delete()
        excess--
        cursor.continue()
      }
    }
  }

  let remaining = entries.length
  if (remaining === 0) trim()
  for (const entry of entries) {
    const getReq = store.get([did, entry.uri])
    getReq.onsuccess = () => {
      const existing = getReq.result as unknown
      if (
        dirty === 0 &&
        isValidRecord(existing) &&
        existing.seenAt === entry.seenAt &&
        existing.dirty !== 0
      ) {
        store.put({...existing, dirty: 0})
      } else if (!isValidRecord(existing) || existing.seenAt < entry.seenAt) {
        const record: SeenRecord = {
          did,
          uri: entry.uri,
          seenAt: entry.seenAt,
          dirty,
        }
        store.put(record)
        written.push({uri: entry.uri, seenAt: entry.seenAt})
      }
      remaining--
      if (remaining === 0) trim()
    }
  }

  await done
  return {written, evicted}
}

/**
 * Up to `limit` records for `did` with `dirty = 1`, through the `did_dirty`
 * index.
 */
export async function readDirtySeen(
  db: IDBDatabase,
  {IDBKeyRange}: IndexedDbGlobals,
  did: string,
  limit: number,
): Promise<SeenEntry[]> {
  const tx = db.transaction(SEEN_STORE, 'readonly')
  const done = txDone(tx)
  const req = tx
    .objectStore(SEEN_STORE)
    .index(SEEN_BY_DIRTY_INDEX)
    .getAll(IDBKeyRange.bound([did, 1], [did, 1]), limit)
  await done
  const entries: SeenEntry[] = []
  for (const value of req.result as unknown[]) {
    if (isValidRecord(value)) {
      entries.push({uri: value.uri, seenAt: value.seenAt})
    }
  }
  return entries
}

/**
 * Sets `dirty = 0` on the records the sync service has accepted. A record
 * whose `seenAt` differs was seen again after it was read for sending, so it
 * stays dirty and goes in a later batch.
 */
export async function markSeenSynced(
  db: IDBDatabase,
  did: string,
  entries: SeenEntry[],
): Promise<void> {
  if (entries.length === 0) return
  const tx = db.transaction(SEEN_STORE, 'readwrite')
  const done = txDone(tx)
  const store = tx.objectStore(SEEN_STORE)
  for (const entry of entries) {
    const getReq = store.get([did, entry.uri])
    getReq.onsuccess = () => {
      const existing = getReq.result as unknown
      if (
        isValidRecord(existing) &&
        existing.seenAt === entry.seenAt &&
        existing.dirty !== 0
      ) {
        store.put({...existing, dirty: 0})
      }
    }
  }
  await done
}

export async function readSeenMeta(
  db: IDBDatabase,
  did: string,
): Promise<SeenMeta | undefined> {
  const tx = db.transaction(META_STORE, 'readonly')
  const done = txDone(tx)
  const req = tx.objectStore(META_STORE).get(did)
  await done
  const value = req.result as Partial<SeenMeta> | undefined
  if (!value || typeof value !== 'object' || value.did !== did) return undefined
  return {
    did,
    lastSyncServerTime:
      typeof value.lastSyncServerTime === 'number' &&
      Number.isFinite(value.lastSyncServerTime)
        ? value.lastSyncServerTime
        : undefined,
  }
}

export async function writeSeenMeta(
  db: IDBDatabase,
  meta: SeenMeta,
): Promise<void> {
  const tx = db.transaction(META_STORE, 'readwrite')
  const done = txDone(tx)
  tx.objectStore(META_STORE).put(meta)
  await done
}

/**
 * {@link SeenStorage} backed by IndexedDB. A failed open is retried on the
 * next call, and a handle that stops working (Safari drops connections when
 * the app is suspended) is reopened.
 */
export function createIndexedDbStorage(
  globals: IndexedDbGlobals,
  {limit = SEEN_LIST_LIMIT}: {limit?: number} = {},
): SeenStorage {
  let dbPromise: Promise<IDBDatabase> | undefined

  const getDb = () => {
    if (!dbPromise) {
      dbPromise = openSeenDb(globals)
      dbPromise.catch(() => {
        dbPromise = undefined
      })
    }
    return dbPromise
  }

  const withDb = async <T>(fn: (db: IDBDatabase) => Promise<T>) => {
    const db = await getDb()
    try {
      return await fn(db)
    } catch (e) {
      // Reopen on the next call in case the connection itself went bad.
      if (dbPromise) {
        dbPromise = undefined
        try {
          db.close()
        } catch {}
      }
      throw e
    }
  }

  return {
    load: did => withDb(db => loadSeen(db, globals, did)),
    write: (did, entries, opts) =>
      withDb(db =>
        writeSeen(db, globals, did, entries, {dirty: opts?.dirty, limit}),
      ),
    readDirty: (did, max) => withDb(db => readDirtySeen(db, globals, did, max)),
    markSynced: (did, entries) =>
      withDb(db => markSeenSynced(db, did, entries)),
    readMeta: did => withDb(db => readSeenMeta(db, did)),
    writeMeta: meta => withDb(db => writeSeenMeta(db, meta)),
  }
}
