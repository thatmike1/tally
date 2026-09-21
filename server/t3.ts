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
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  return join(home, '.t3', 'userdata', 'state.sqlite')
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
   ORDER BY thread_id, created_at
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
export function otherThreads(from: number, to: number, path = statePath()): Thread[] {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return []
  }
  try {
    const times = new Map<string, number[]>()
    for (const row of db.prepare(MESSAGES_SQL).all() as Record<string, unknown>[]) {
      const id = String(row.id)
      const t = seconds(row.t, Number.NaN)
      if (Number.isNaN(t)) continue
      const list = times.get(id)
      if (list) list.push(t)
      else times.set(id, [t])
    }
    const rows = db.prepare(SQL).all() as Record<string, unknown>[]
    const out: Thread[] = []
    for (const row of rows) {
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
      const segments = segmentsOfTimes(inWindow)
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
