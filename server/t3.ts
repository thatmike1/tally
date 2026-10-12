// non-Claude agent threads (Antigravity, Codex, opencode) out of T3 Code's own
// state db. title, kind, stretches of activity, live tag, and deliberately no
// points: there is no usage data for these and none is invented.
//
// a thread is a span only on paper: T3 keeps one row per message, so a thread
// poked twice three days apart is two minutes of work and three days of
// nothing. first-to-last would draw that as a three-day bar, so the messages
// are merged into segments the same way a Claude lane's requests are.
//
// T3 Code is running and writing to this file, so it is opened read-only.
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jsonObject } from './codex-speed'
import { LANE_GAP } from './history-types'

export interface ThreadSegment {
  start: number
  end: number
}

export interface Thread {
  id: string
  title: string
  /** the provider, as T3 records it: `antigravity`, `codex`, `opencode` */
  kind: string
  project: string | null
  /** first activity inside the window, not the thread's own first message */
  start: number
  /** last activity inside the window */
  end: number
  /** the thread's first message ever, when it is older than the window */
  began: number | null
  /** stretches of activity inside the window; messages closer than `LANE_GAP` merged */
  segments: ThreadSegment[]
  live: boolean
}

export function statePath(home = homedir()): string {
  const v2 = join(home, '.t3', 'userdata', 'statev2.sqlite')
  return existsSync(v2) ? v2 : join(home, '.t3', 'userdata', 'state.sqlite')
}

const SQL = `
  SELECT t.thread_id AS id,
         t.title AS title,
         p.title AS project,
         s.provider_name AS provider,
         s.status AS status,
         s.active_turn_id AS active_turn_id,
         t.created_at AS created_at,
         t.updated_at AS updated_at
    FROM projection_threads t
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
   WHERE t.deleted_at IS NULL
`

const MESSAGES_SQL = `
  SELECT thread_id AS id, created_at AS t
    FROM projection_thread_messages
`

/** checks projections in the selected database, never the frozen sibling file */
function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !== undefined
}

const V2_SQL = `
  SELECT t.thread_id AS id, t.title, p.title AS project,
         COALESCE(pt.provider, t.default_provider) AS provider,
         CASE WHEN EXISTS (
           SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = t.thread_id AND r.status = 'running'
         ) THEN t.active_provider_thread_id END AS active_turn_id,
         t.created_at, t.updated_at
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_provider_threads pt
      ON pt.provider_thread_id = t.active_provider_thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
   WHERE t.deleted_at IS NULL
`

function seconds(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? fallback : ms / 1000
}

/**
 * message times into stretches of activity: anything further apart than `gap`
 * opens a new one, so the idle hours between two pokes are drawn as the nothing
 * they were.
 */
export function segmentsOfTimes(times: number[], gap = LANE_GAP): ThreadSegment[] {
  const sorted = [...times].sort((a, b) => a - b)
  const segments: ThreadSegment[] = []
  for (const t of sorted) {
    const open = segments.at(-1)
    if (!open || t - open.end > gap) segments.push({ start: t, end: t })
    else open.end = t
  }
  return segments
}

/**
 * threads that were active in [from, to) and are not Claude.
 *
 * Claude threads are excluded because the same work already appears in the
 * split, off its transcript, with real numbers on it.
 */
export function otherThreads(from: number, to: number, path = statePath(), gap = LANE_GAP): Thread[] {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return []
  }
  try {
    const times = new Map<string, number[]>()
    const v2 = hasTable(db, 'orchestration_v2_projection_threads')
    const messages = v2 ? `${MESSAGES_SQL}
      UNION SELECT thread_id AS id, created_at AS t FROM orchestration_v2_projection_messages
      ORDER BY id, t` : MESSAGES_SQL
    for (const row of db.prepare(messages).all()) {
      const id = String(row.id)
      const t = seconds(row.t, Number.NaN)
      if (Number.isNaN(t)) continue
      const list = times.get(id)
      if (list) list.push(t)
      else times.set(id, [t])
    }
    const rows = new Map(db.prepare(SQL).all().map((row) => [String(row.id), row]))
    if (v2) {
      for (const row of db.prepare(V2_SQL).all()) rows.set(String(row.id), row)
      // deleted V2 threads must not reappear through their imported V1 row
      for (const row of db.prepare('SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL').all()) {
        rows.delete(String(row.thread_id))
      }
    }
    const out: Thread[] = []
    for (const row of rows.values()) {
      const provider = String(row.provider ?? '')
      if (!provider || provider === 'claudeAgent') continue
      const id = String(row.id)
      const own = times.get(id) ?? []
      const created = seconds(row.created_at, 0)
      const updated = seconds(row.updated_at, created)
      // a thread with no message rows is a mark at its last update, never a
      // bar from creation to now: nothing says it was busy in between
      const inWindow = own.length ? own.filter((t) => t >= from && t < to) : updated >= from && updated < to ? [updated] : []
      if (!inWindow.length) continue
      const segments = segmentsOfTimes(inWindow, gap)
      const first = own.length ? Math.min(...own) : created
      out.push({
        id,
        title: String(row.title ?? 'untitled'),
        kind: provider,
        project: row.project === null || row.project === undefined ? null : String(row.project),
        start: segments[0]!.start,
        end: segments.at(-1)!.end,
        began: first < from ? first : null,
        segments,
        // a turn in flight is the only honest "live"; `status = ready` only means
        // the provider process is attached, which it stays for hours
        live: row.active_turn_id !== null && row.active_turn_id !== undefined,
      })
    }
    out.sort((a, b) => a.start - b.start)
    return out
  } catch {
    return []
  } finally {
    db.close()
  }
}

export interface NativeThread {
  threadId: string
  title: string
  live: boolean
  cwd: string | null
}

/** parses optional provider JSON without trusting its shape */
function payload(value: unknown): Record<string, unknown> | null {
  try {
    return jsonObject(JSON.parse(String(value ?? '{}')))
  } catch {
    return null
  }
}

/**
 * native sessions from both generations, including handoffs and legacy history.
 * v2 wins a duplicate native id; newest provider records win within V2.
 */
export function nativeThreads(provider: string, path = statePath()): Map<string, NativeThread> {
  const out = new Map<string, NativeThread>()
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return out
  }
  try {
    if (hasTable(db, 'provider_session_runtime')) {
      const sessions = hasTable(db, 'projection_thread_sessions')
      const rows = db.prepare(`
        SELECT t.thread_id, t.title, r.resume_cursor_json AS cursor,
               ${sessions ? 's.active_turn_id' : 'NULL'} AS active
          FROM provider_session_runtime r
          JOIN projection_threads t ON t.thread_id = r.thread_id
          ${sessions ? 'LEFT JOIN projection_thread_sessions s ON s.thread_id = r.thread_id' : ''}
         WHERE r.provider_name = ? AND t.deleted_at IS NULL
      `).all(provider)
      for (const row of rows) {
        const cursor = payload(row.cursor)
        const id = provider === 'claudeAgent' ? cursor?.resume : cursor?.threadId
        if (typeof id !== 'string' || !id) continue
        if (provider === 'claudeAgent' && (typeof row.title !== 'string' || !row.title.trim())) continue
        out.set(id, {
          threadId: String(row.thread_id), title: provider === 'claudeAgent' ? String(row.title).trim() : String(row.title ?? 'untitled'),
          live: row.active !== null, cwd: null,
        })
      }
    }
    if (hasTable(db, 'orchestration_v2_projection_provider_threads')) {
      for (const [id, thread] of out) out.set(id, { ...thread, live: false })
      const rows = db.prepare(`
        SELECT pt.thread_id, t.title, pt.payload_json, ps.payload_json AS session,
               CASE WHEN pt.provider_thread_id = t.active_provider_thread_id AND EXISTS (
                 SELECT 1 FROM orchestration_v2_projection_runs r
                  WHERE r.provider_thread_id = pt.provider_thread_id AND r.status = 'running'
               ) THEN 1 ELSE 0 END AS live
          FROM orchestration_v2_projection_provider_threads pt
          JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
          LEFT JOIN orchestration_v2_projection_provider_sessions ps
            ON ps.provider_session_id = pt.provider_session_id
         WHERE pt.provider = ? AND t.deleted_at IS NULL
         ORDER BY pt.updated_at
      `).all(provider)
      for (const row of rows) {
        const id = jsonObject(payload(row.payload_json)?.nativeThreadRef)?.nativeId
        if (typeof id !== 'string' || !id) continue
        const cwd = payload(row.session)?.cwd
        out.set(id, {
          threadId: String(row.thread_id), title: provider === 'claudeAgent' ? String(row.title).trim() : String(row.title ?? 'untitled'),
          live: row.live === 1, cwd: typeof cwd === 'string' ? cwd : null,
        })
      }
    }
  } catch {
    // missing optional projections leave the available legacy mappings intact
  } finally {
    db.close()
  }
  return out
}

/** t3 titles for every recorded Claude session, before and after handoffs */
export function claudeThreadTitles(path = statePath()): Map<string, string> {
  return new Map([...nativeThreads('claudeAgent', path)]
    .filter(([, thread]) => thread.title)
    .map(([id, thread]) => [id, thread.title]))
}
