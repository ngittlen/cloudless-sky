/*
 * A small in-memory IndexedDB for unit tests. It covers only what
 * `seen/db.ts` uses: opening with an upgrade, object stores with array key
 * paths, compound indexes, get, put, getAll (on stores and indexes), count,
 * and index cursors with delete. Requests in a transaction run in order,
 * asynchronously, and the transaction completes once no requests remain, as
 * in a browser.
 *
 * The repo has no fake-indexeddb dependency, and adding one would change
 * package.json and the lockfile, which conflicts with upstream merges.
 */

type Key = number | string | Key[]

function typeRank(k: Key): number {
  if (typeof k === 'number') return 1
  if (typeof k === 'string') return 3
  return 5
}

/**
 * IndexedDB key order: numbers, then strings, then arrays, with arrays
 * compared item by item and a shorter prefix sorting first.
 */
export function compareKeys(a: Key, b: Key): number {
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return ra - rb
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i])
      if (c !== 0) return c
    }
    return a.length - b.length
  }
  return a < b ? -1 : a > b ? 1 : 0
}

export class FakeKeyRange {
  constructor(
    public lower: Key,
    public upper: Key,
  ) {}

  static bound(lower: Key, upper: Key) {
    return new FakeKeyRange(lower, upper)
  }

  includes(key: Key) {
    return (
      compareKeys(this.lower, key) <= 0 && compareKeys(key, this.upper) <= 0
    )
  }
}

function keyFrom(value: Record<string, unknown>, keyPath: string | string[]) {
  return (
    Array.isArray(keyPath) ? keyPath.map(p => value[p]) : value[keyPath]
  ) as Key
}

type StoreData = {
  keyPath: string | string[]
  records: Map<string, {key: Key; value: Record<string, unknown>}>
  indexes: Map<string, string | string[]>
}

class FakeRequest {
  result: unknown
  error: Error | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
}

class FakeTransaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: Error | null = null
  private queue: (() => void)[] = []
  private scheduled = false
  private finished = false

  constructor(private db: FakeDatabase) {
    this.schedule()
  }

  objectStore(name: string) {
    const data = this.db.stores.get(name)
    if (!data) throw new Error(`No store ${name}`)
    return new FakeObjectStore(this, data)
  }

  request(run: (req: FakeRequest) => void): FakeRequest {
    const req = new FakeRequest()
    this.queue.push(() => {
      if (this.db.failRequests) {
        req.error = new Error('Fake request failure')
        req.onerror?.()
        this.abort(req.error)
        return
      }
      run(req)
    })
    this.schedule()
    return req
  }

  private schedule() {
    if (this.scheduled || this.finished) return
    this.scheduled = true
    setTimeout(() => this.run(), 0)
  }

  private run() {
    this.scheduled = false
    while (this.queue.length > 0 && !this.finished) {
      this.queue.shift()!()
    }
    if (!this.finished) {
      this.finished = true
      this.oncomplete?.()
    }
  }

  private abort(error: Error) {
    if (this.finished) return
    this.finished = true
    this.queue = []
    this.error = error
    this.onerror?.()
    this.onabort?.()
  }
}

class FakeObjectStore {
  constructor(
    private tx: FakeTransaction,
    private data: StoreData,
  ) {}

  createIndex(name: string, keyPath: string | string[]) {
    this.data.indexes.set(name, keyPath)
  }

  get(key: Key) {
    return this.tx.request(req => {
      req.result = this.data.records.get(JSON.stringify(key))?.value
      req.onsuccess?.()
    })
  }

  put(value: Record<string, unknown>) {
    return this.tx.request(req => {
      const key = keyFrom(value, this.data.keyPath)
      this.data.records.set(JSON.stringify(key), {
        key,
        value: structuredClone(value),
      })
      req.result = key
      req.onsuccess?.()
    })
  }

  getAll(range: FakeKeyRange) {
    return this.tx.request(req => {
      req.result = [...this.data.records.values()]
        .filter(r => range.includes(r.key))
        .sort((a, b) => compareKeys(a.key, b.key))
        .map(r => structuredClone(r.value))
      req.onsuccess?.()
    })
  }

  index(name: string) {
    const keyPath = this.data.indexes.get(name)
    if (!keyPath) throw new Error(`No index ${name}`)
    return new FakeIndex(this.tx, this.data, keyPath)
  }
}

class FakeIndex {
  constructor(
    private tx: FakeTransaction,
    private data: StoreData,
    private keyPath: string | string[],
  ) {}

  private entries(range: FakeKeyRange) {
    return [...this.data.records.values()]
      .map(r => ({indexKey: keyFrom(r.value, this.keyPath), ...r}))
      .filter(r => range.includes(r.indexKey))
      .sort(
        (a, b) =>
          compareKeys(a.indexKey, b.indexKey) || compareKeys(a.key, b.key),
      )
  }

  getAll(range: FakeKeyRange, count?: number) {
    return this.tx.request(req => {
      const values = this.entries(range).map(r => structuredClone(r.value))
      req.result = count === undefined ? values : values.slice(0, count)
      req.onsuccess?.()
    })
  }

  count(range: FakeKeyRange) {
    return this.tx.request(req => {
      req.result = this.entries(range).length
      req.onsuccess?.()
    })
  }

  openCursor(range: FakeKeyRange) {
    const snapshot = this.entries(range)
    let position = 0
    let req: FakeRequest
    const step = (r: FakeRequest) => {
      const entry = snapshot[position]
      if (!entry) {
        r.result = null
      } else {
        r.result = {
          key: entry.indexKey,
          primaryKey: entry.key,
          value: structuredClone(entry.value),
          delete: () =>
            this.tx.request(() => {
              this.data.records.delete(JSON.stringify(entry.key))
            }),
          continue: () => {
            position++
            this.tx.request(() => step(req))
          },
        }
      }
      r.onsuccess?.()
    }
    req = this.tx.request(r => step(r))
    return req
  }
}

class FakeDatabase {
  stores = new Map<string, StoreData>()
  failRequests = false
  onversionchange: (() => void) | null = null
  closed = false

  constructor(public version: number) {}

  get objectStoreNames() {
    return {contains: (name: string) => this.stores.has(name)}
  }

  createObjectStore(name: string, {keyPath}: {keyPath: string | string[]}) {
    const data: StoreData = {keyPath, records: new Map(), indexes: new Map()}
    this.stores.set(name, data)
    return new FakeObjectStore(new FakeTransaction(this), data)
  }

  transaction(_names: string | string[], _mode?: string) {
    if (this.closed) throw new Error('The database connection is closing.')
    return new FakeTransaction(this)
  }

  close() {
    this.closed = true
  }
}

class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: (() => void) | null = null
  onblocked: (() => void) | null = null
}

/**
 * A fake `indexedDB` factory. Databases persist across `open` calls on the
 * same factory, which stands in for reopening the app.
 */
export class FakeIndexedDb {
  databases = new Map<string, FakeDatabase>()
  failOpen = false
  hangOpen = false

  open(name: string, version: number) {
    const req = new FakeOpenRequest()
    setTimeout(() => {
      if (this.hangOpen) return
      if (this.failOpen) {
        req.error = new Error('Fake open failure')
        req.onerror?.()
        return
      }
      const existing = this.databases.get(name)
      if (!existing || existing.version < version) {
        const db = existing ?? new FakeDatabase(version)
        db.version = version
        this.databases.set(name, db)
        req.result = db
        req.onupgradeneeded?.()
      }
      // Each open returns a fresh connection to the same data.
      const stored = this.databases.get(name)!
      const connection = Object.create(stored) as FakeDatabase
      connection.closed = false
      req.result = connection
      req.onsuccess?.()
    }, 0)
    return req
  }

  /**
   * Every record in a store, for assertions.
   */
  dump(name: string, store: string) {
    const data = this.databases.get(name)?.stores.get(store)
    return data ? [...data.records.values()].map(r => r.value) : []
  }

  /**
   * Makes every request on existing and future connections fail, or stop
   * failing.
   */
  setFailRequests(name: string, fail: boolean) {
    const db = this.databases.get(name)
    if (db) db.failRequests = fail
  }
}

/**
 * Globals for `createIndexedDbStorage`, backed by a fresh fake.
 */
export function createFakeIndexedDbGlobals(fake = new FakeIndexedDb()) {
  return {
    fake,
    globals: {
      indexedDB: fake as unknown as IDBFactory,
      IDBKeyRange: FakeKeyRange as unknown as typeof IDBKeyRange,
    },
  }
}
