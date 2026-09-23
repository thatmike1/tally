// a per-file cache of the request records `transcripts.ts` parses, so a window
// of history never streams the transcript tree again (9.8 GB, 6531 files on
// 16 Sep 2026).
//
// one sqlite db, two tables: `files` keyed on the path with the mtime and size
// that were parsed, `requests` with exactly the `RequestRecord` fields. a file
// whose mtime and size still match is never reread, so the pass after the first
// one costs a stat per file.
//
// the first build walks newest-mtime-first, so the block the page is showing is
// indexed within seconds of a cold start; `covers()` says how far back the
// build has reached and `buildState` falls back to a live `scan()` until it is
// deep enough.
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { IndexProgress } from './history-types'
import { costOf, familyOf, PRICE_TABLE_KEY, priceFor } from './prices'
import {
  parseTranscript,
  projectsRoot,
  transcriptFiles,
  type ParsedTranscript,
  type RequestRecord,
  type SessionMeta,
  type TranscriptFile,
} from './transcripts'

/** the index db; `~/.cache/tally/transcripts.sqlite` */
export function indexPath(home = homedir()): string {
  return join(home, '.cache', 'tally', 'transcripts.sqlite')
}

/** what one pass over the tree did, for the log line */
export interface RefreshCounts {
  /** transcript files found on disk */
  seen: number
  /** files read and reparsed: new, changed in mtime or size */
  parsed: number
  /** files whose mtime and size still matched the index */
  skipped: number
  /** indexed files that no longer exist */
  dropped: number
  /**
   * files whose parse or store threw and that are still on disk afterwards.
   * they are left out of `files`, so the next pass reads them again.
   */
  failed: number
  /** records written by this pass */
  records: number
  seconds: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  agent INTEGER NOT NULL,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  title TEXT,
  cwd TEXT,
  first_t REAL,
  last_t REAL,
  lines INTEGER
);
CREATE INDEX IF NOT EXISTS files_session ON files(session_id);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime);
CREATE TABLE IF NOT EXISTS requests (
  file_id INTEGER NOT NULL,
  mid TEXT NOT NULL,
  t REAL NOT NULL,
  agent INTEGER NOT NULL,
  model TEXT NOT NULL,
  family TEXT NOT NULL,
  priced INTEGER NOT NULL,
  cost REAL NOT NULL,
  tin INTEGER NOT NULL,
  cw1h INTEGER NOT NULL,
  cw5m INTEGER NOT NULL,
  cr INTEGER NOT NULL,
  tout INTEGER NOT NULL,
  PRIMARY KEY (file_id, mid)
);
CREATE INDEX IF NOT EXISTS requests_t ON requests(t);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`

/** one row of `files`, as the detail view asks about a single transcript */
export interface FileState {
  id: number
  mtime: number
  size: number
  title: string | null
  cwd: string | null
}

/** how many files a pass handles before it gives the event loop a turn */
const YIELD_EVERY = 250

function toRecord(row: Record<string, any>): RequestRecord {
  const model = String(row.model)
  return {
    t: Number(row.t),
    file: String(row.path),
    mid: String(row.mid),
    project: String(row.project),
    sessionId: String(row.session_id),
    agent: Boolean(row.agent),
    model,
    // recomputed rather than cast, so a price-table edit can never disagree with `scan`
    family: familyOf(model),
    priced: Boolean(row.priced),
    cost: Number(row.cost),
    in: Number(row.tin),
    cw1h: Number(row.cw1h),
    cw5m: Number(row.cw5m),
    cr: Number(row.cr),
    out: Number(row.tout),
  }
}

const RECORD_COLUMNS = `f.path AS path, f.session_id AS session_id, f.project AS project,
  r.mid AS mid, r.t AS t, r.agent AS agent, r.model AS model, r.family AS family,
  r.priced AS priced, r.cost AS cost, r.tin AS tin, r.cw1h AS cw1h, r.cw5m AS cw5m,
  r.cr AS cr, r.tout AS tout`

export interface IndexOptions {
  /** `~/.claude/projects` unless a test points elsewhere */
  root?: string
  /** the db file; `:memory:` for a throwaway one */
  path?: string
  home?: string
}

/**
 * the transcript index: incremental, safe to read while it builds, and never
 * the thing a request waits on.
 */
export class TranscriptIndex {
  readonly root: string
  readonly path: string
  private readonly db: DatabaseSync
  private readonly statements: {
    fileByPath: StatementSync
    insertFile: StatementSync
    updateFile: StatementSync
    deleteRequests: StatementSync
    insertRequest: StatementSync
    deleteFile: StatementSync
    allFiles: StatementSync
    window: StatementSync
    bySession: StatementSync
    byFile: StatementSync
    sessions: StatementSync
    setMeta: StatementSync
    getMeta: StatementSync
  }
  private builtAt: number | null = null
  private building = false
  private done = 0
  private total = 0
  /** files the pass could not read, still on disk when it looked again */
  private failed = 0
  /** the oldest mtime this build has reached; everything newer is indexed */
  private frontier = Number.POSITIVE_INFINITY
  private running: Promise<RefreshCounts> | null = null

  constructor(options: IndexOptions = {}) {
    const home = options.home ?? homedir()
    this.root = options.root ?? projectsRoot(home)
    this.path = options.path ?? indexPath(home)
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
    this.statements = {
      fileByPath: this.db.prepare('SELECT id, mtime, size, title, cwd FROM files WHERE path = ?'),
      insertFile: this.db.prepare(
        `INSERT INTO files (path, session_id, project, agent, mtime, size, title, cwd, first_t, last_t, lines)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateFile: this.db.prepare(
        `UPDATE files SET session_id = ?, project = ?, agent = ?, mtime = ?, size = ?, title = ?, cwd = ?,
         first_t = ?, last_t = ?, lines = ? WHERE id = ?`,
      ),
      deleteRequests: this.db.prepare('DELETE FROM requests WHERE file_id = ?'),
      insertRequest: this.db.prepare(
        `INSERT INTO requests (file_id, mid, t, agent, model, family, priced, cost, tin, cw1h, cw5m, cr, tout)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
      allFiles: this.db.prepare('SELECT id, path, mtime, size FROM files'),
      window: this.db.prepare(
        `SELECT ${RECORD_COLUMNS} FROM requests r JOIN files f ON f.id = r.file_id
          WHERE r.t >= ? AND r.t < ? ORDER BY r.t`,
      ),
      bySession: this.db.prepare(
        `SELECT ${RECORD_COLUMNS} FROM requests r JOIN files f ON f.id = r.file_id
          WHERE f.session_id = ? ORDER BY r.t`,
      ),
      byFile: this.db.prepare(
        `SELECT ${RECORD_COLUMNS} FROM requests r JOIN files f ON f.id = r.file_id
          WHERE f.path = ? ORDER BY r.t`,
      ),
      sessions: this.db.prepare(
        'SELECT session_id, project, title, cwd, mtime FROM files WHERE agent = 0 AND mtime >= ?',
      ),
      setMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
    }
    const stored = this.statements.getMeta.get('built_at') as { value?: string } | undefined
    this.builtAt = stored?.value ? Number(stored.value) : null
    this.repriceIfStale()
  }

  /**
   * a stored cost is frozen at the price table it was parsed under, and an
   * unchanged file is never reread, so a price edit reprices every row from the
   * tokens it kept. runs once per table change, keyed in `meta`.
   */
  private repriceIfStale(): void {
    const stored = this.statements.getMeta.get('prices') as { value?: string } | undefined
    if (stored?.value === PRICE_TABLE_KEY) return
    const rows = this.db.prepare('SELECT rowid, model, tin, cw1h, cw5m, cr, tout FROM requests').all()
    const update = this.db.prepare('UPDATE requests SET priced = ?, cost = ? WHERE rowid = ?')
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        const model = String(row.model)
        const cost = costOf(model, {
          in: Number(row.tin),
          cw1h: Number(row.cw1h),
          cw5m: Number(row.cw5m),
          cr: Number(row.cr),
          out: Number(row.tout),
        })
        update.run(priceFor(model) !== null ? 1 : 0, cost, Number(row.rowid))
      }
      this.statements.setMeta.run('prices', PRICE_TABLE_KEY, PRICE_TABLE_KEY)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** what `/api/state` prints while the tree is being read */
  progress(): IndexProgress {
    return {
      building: this.building,
      done: this.done,
      total: this.total,
      builtAt: this.builtAt,
      cold: this.builtAt === null,
      failed: this.failed,
    }
  }

  /**
   * every file with an mtime at or after `from` is indexed, so a window opening
   * at `from` can be answered from the db alone.
   */
  covers(from: number): boolean {
    if (this.builtAt !== null) return true
    return this.frontier <= from
  }

  /** one incremental pass; concurrent callers share the pass already running */
  refresh(): Promise<RefreshCounts> {
    if (this.running) return this.running
    const pass = this.pass().finally(() => {
      this.running = null
      this.building = false
      // a pass that threw leaves no coverage claim behind
      this.frontier = this.builtAt === null ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    })
    this.running = pass
    return pass
  }

  private async pass(): Promise<RefreshCounts> {
    const started = Date.now()
    // newest first, so the block the page is showing lands in the index first
    const files = transcriptFiles(this.root).sort((a, b) => b.mtime - a.mtime)
    const known = new Map<string, { id: number; mtime: number; size: number }>()
    for (const row of this.statements.allFiles.all() as Record<string, any>[]) {
      known.set(String(row.path), { id: Number(row.id), mtime: Number(row.mtime), size: Number(row.size) })
    }
    this.building = true
    this.done = 0
    this.total = files.length
    if (this.builtAt === null) this.frontier = Number.POSITIVE_INFINITY
    let parsed = 0
    let skipped = 0
    let records = 0
    let dropped = 0
    this.failed = 0
    for (const file of files) {
      const row = known.get(file.path)
      known.delete(file.path)
      if (row && row.mtime === file.mtime && row.size === file.size) {
        skipped++
      } else {
        try {
          const result = await parseTranscript(file)
          this.store(file, result, row?.id ?? null)
          records += result.records.length
          parsed++
        } catch {
          // nothing was written: `store` rolls back. a file that is still on disk
          // is a failure: its old rows go too, so nothing claims it is indexed and
          // the next pass reads it again. a file that vanished mid-pass is not a
          // failure, it is gone, and it is dropped like any other missing file
          if (row) {
            this.statements.deleteRequests.run(row.id)
            this.statements.deleteFile.run(row.id)
          }
          if (existsSync(file.path)) this.failed++
          else dropped++
        }
      }
      this.done++
      this.frontier = file.mtime
      if (this.done % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    for (const gone of known.values()) {
      this.statements.deleteRequests.run(gone.id)
      this.statements.deleteFile.run(gone.id)
    }
    // a file that can never be read must not hold the build open forever, so the
    // pass completes and `progress().failed` carries what it could not index
    this.builtAt = Math.round(Date.now() / 1000)
    this.statements.setMeta.run('built_at', String(this.builtAt), String(this.builtAt))
    return {
      seen: files.length,
      parsed,
      skipped,
      dropped: known.size + dropped,
      failed: this.failed,
      records,
      seconds: (Date.now() - started) / 1000,
    }
  }

  /** one file's rows, replaced inside a transaction so a reader never sees half of it */
  private store(file: TranscriptFile, parsed: ParsedTranscript, id: number | null): void {
    let first: number | null = null
    let last: number | null = null
    for (const record of parsed.records) {
      if (first === null || record.t < first) first = record.t
      if (last === null || record.t > last) last = record.t
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let fileId = id
      if (fileId === null) {
        const inserted = this.statements.insertFile.run(
          file.path,
          file.sessionId,
          file.project,
          file.agent ? 1 : 0,
          file.mtime,
          file.size,
          parsed.title,
          parsed.cwd,
          first,
          last,
          parsed.lines,
        )
        fileId = Number(inserted.lastInsertRowid)
      } else {
        this.statements.updateFile.run(
          file.sessionId,
          file.project,
          file.agent ? 1 : 0,
          file.mtime,
          file.size,
          parsed.title,
          parsed.cwd,
          first,
          last,
          parsed.lines,
          fileId,
        )
        this.statements.deleteRequests.run(fileId)
      }
      for (const record of parsed.records) {
        this.statements.insertRequest.run(
          fileId,
          record.mid,
          record.t,
          record.agent ? 1 : 0,
          record.model,
          record.family,
          record.priced ? 1 : 0,
          record.cost,
          record.in,
          record.cw1h,
          record.cw5m,
          record.cr,
          record.out,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** every indexed request with `from <= t < to`, and the sessions behind them */
  query(from: number, to: number): { records: RequestRecord[]; sessions: Map<string, SessionMeta> } {
    const records = (this.statements.window.all(from, to) as Record<string, any>[]).map(toRecord)
    const sessions = new Map<string, SessionMeta>()
    for (const row of this.statements.sessions.all(from) as Record<string, any>[]) {
      sessions.set(String(row.session_id), {
        sessionId: String(row.session_id),
        project: String(row.project),
        title: row.title === null || row.title === undefined ? null : String(row.title),
        modified: Number(row.mtime),
        cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
      })
    }
    return { records, sessions }
  }

  /** every indexed request of one session, parent and subagent files together */
  sessionRecords(sessionId: string): RequestRecord[] {
    return (this.statements.bySession.all(sessionId) as Record<string, any>[]).map(toRecord)
  }

  /** what the index holds for one transcript file, or null when it has never read it */
  fileState(path: string): FileState | null {
    const row = this.statements.fileByPath.get(path) as Record<string, any> | undefined
    if (!row) return null
    return {
      id: Number(row.id),
      mtime: Number(row.mtime),
      size: Number(row.size),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
    }
  }

  /** one file's indexed records, oldest first */
  fileRecords(path: string): RequestRecord[] {
    return (this.statements.byFile.all(path) as Record<string, any>[]).map(toRecord)
  }

  close(): void {
    this.db.close()
  }
}
