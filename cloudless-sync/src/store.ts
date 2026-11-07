import {DatabaseSync, type StatementSync} from 'node:sqlite'

import {PAGE_SIZE, SEEN_LIST_LIMIT} from './constants.ts'

/**
 * A seen post: its AT URI and when it was seen, in milliseconds since the
 * epoch.
 */
export type SeenEntry = {uri: string; seenAt: number}

export type ChangesPage = {
  entries: SeenEntry[]
  /**
   * The value to pass as `since` on the next check, once `cursor` is absent.
   * Every change up to it is in this page or an earlier one of the same
   * series.
   */
  serverTime: number
  /**
   * Present while more changes remain; pass it back to get the next page.
   */
  cursor?: string
}

/**
 * A `cursor` or `since` this service could not have returned.
 */
export class InvalidPositionError extends Error {}

/**
 * How far past the service's own time a `since` may be. A database restored
 * from elsewhere or a clock that stepped back stays well inside it, and the
 * bound keeps the logical clock far from the largest exact integer.
 */
export const MAX_SINCE_AHEAD_MS = 24 * 60 * 60 * 1000

type CursorPosition = {updatedAt: number; uri: string}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify([position.updatedAt, position.uri]),
  ).toString('base64url')
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    )
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === 'string'
    ) {
      return {updatedAt: value[0] as number, uri: value[1]}
    }
  } catch {}
  throw new InvalidPositionError('cursor is not one this service returned')
}

/**
 * Seen lists for every account, in one SQLite file.
 *
 * `updated_at` is not wall-clock time but a per-process logical clock that
 * starts at the later of now and the largest stored value, and increases by
 * at least 1 for every write batch. Each batch therefore has its own
 * `updated_at`, later than any row already stored, so a reader paging by
 * `(updated_at, uri)` sees every later write after its position even when
 * the system clock steps backwards. Node runs each request's statements
 * without interleaving, so a read never sees half a batch.
 */
export class SeenStore {
  private db: DatabaseSync
  private now: () => number
  private limit: number
  private pageSize: number
  private clock: number

  private upsertStmt: StatementSync
  private countStmt: StatementSync
  private trimStmt: StatementSync
  private changesStmt: StatementSync
  private changesAfterStmt: StatementSync

  constructor(
    path: string,
    {
      now = Date.now,
      limit = SEEN_LIST_LIMIT,
      pageSize = PAGE_SIZE,
    }: {now?: () => number; limit?: number; pageSize?: number} = {},
  ) {
    this.now = now
    this.limit = limit
    this.pageSize = pageSize
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS seen (
        did TEXT NOT NULL,
        uri TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (did, uri)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS seen_did_updated_at
        ON seen (did, updated_at, uri);
      CREATE INDEX IF NOT EXISTS seen_did_seen_at
        ON seen (did, seen_at, uri);
    `)

    const row = this.db
      .prepare('SELECT max(updated_at) AS latest FROM seen')
      .get() as {latest: number | null} | undefined
    this.clock = Math.max(this.now(), row?.latest ?? 0)

    /*
     * `updated_at` moves only when `seen_at` does, so re-sending an entry a
     * device already has does not make every device fetch it again.
     */
    this.upsertStmt = this.db.prepare(`
      INSERT INTO seen (did, uri, seen_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (did, uri) DO UPDATE
        SET seen_at = excluded.seen_at, updated_at = excluded.updated_at
        WHERE excluded.seen_at > seen.seen_at
    `)
    this.countStmt = this.db.prepare(
      'SELECT count(*) AS n FROM seen WHERE did = ?',
    )
    /*
     * The device's IndexedDB drops the lowest `[did, seenAt]` first, with
     * ties in URI order; the same order here keeps both copies identical.
     */
    this.trimStmt = this.db.prepare(`
      DELETE FROM seen
      WHERE did = ? AND uri IN (
        SELECT uri FROM seen WHERE did = ?
        ORDER BY seen_at, uri
        LIMIT ?
      )
    `)
    this.changesStmt = this.db.prepare(`
      SELECT uri, seen_at, updated_at FROM seen
      WHERE did = ? AND updated_at > ?
      ORDER BY updated_at, uri
      LIMIT ?
    `)
    this.changesAfterStmt = this.db.prepare(`
      SELECT uri, seen_at, updated_at FROM seen
      WHERE did = ? AND updated_at > ? AND (updated_at, uri) > (?, ?)
      ORDER BY updated_at, uri
      LIMIT ?
    `)
  }

  /**
   * The next logical time, later than every one handed out before.
   */
  private tick(): number {
    this.clock = Math.max(this.now(), this.clock + 1)
    return this.clock
  }

  /**
   * Stores a batch for `did`, keeping the later `seenAt` for posts already
   * stored, then drops the posts seen longest ago past the limit. All of it
   * happens in one transaction.
   */
  write(did: string, entries: SeenEntry[]): {serverTime: number} {
    const updatedAt = this.tick()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        this.upsertStmt.run(did, entry.uri, entry.seenAt, updatedAt)
      }
      const {n} = this.countStmt.get(did) as {n: number}
      const excess = n - this.limit
      if (excess > 0) {
        this.trimStmt.run(did, did, excess)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return {serverTime: updatedAt}
  }

  /**
   * Entries for `did` added or moved later after `since`, oldest change
   * first, a page at a time.
   */
  changes(
    did: string,
    {since = 0, cursor}: {since?: number; cursor?: string} = {},
  ): ChangesPage {
    /*
     * A `since` past the clock comes from a database that was replaced or a
     * clock that stepped back. Moving the clock up to it keeps later writes
     * after that device's position, so it does not miss them.
     */
    if (since > Math.max(this.clock, this.now()) + MAX_SINCE_AHEAD_MS) {
      throw new InvalidPositionError(
        'since is later than any serverTime this service has returned',
      )
    }
    if (since > this.clock) this.clock = since
    const position = cursor === undefined ? undefined : decodeCursor(cursor)
    const rows = (
      position
        ? this.changesAfterStmt.all(
            did,
            since,
            position.updatedAt,
            position.uri,
            this.pageSize + 1,
          )
        : this.changesStmt.all(did, since, this.pageSize + 1)
    ) as {uri: string; seen_at: number; updated_at: number}[]

    const serverTime = this.clock
    const more = rows.length > this.pageSize
    const page = more ? rows.slice(0, this.pageSize) : rows
    const entries = page.map(r => ({uri: r.uri, seenAt: r.seen_at}))
    if (!more) return {entries, serverTime}
    const last = page[page.length - 1]
    return {
      entries,
      serverTime,
      cursor: encodeCursor({updatedAt: last.updated_at, uri: last.uri}),
    }
  }

  count(did: string): number {
    return (this.countStmt.get(did) as {n: number}).n
  }

  /**
   * Whether the database answers a query.
   */
  isHealthy(): boolean {
    try {
      this.db.prepare('SELECT 1').get()
      return true
    } catch {
      return false
    }
  }

  close() {
    if (this.db.isOpen) this.db.close()
  }
}
