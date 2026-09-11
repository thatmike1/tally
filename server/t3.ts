// non-Claude agent threads (Antigravity, Codex, opencode) out of T3 Code's own
// state db. title, kind, time span, live tag, and deliberately no points: there
// is no usage data for these and none is invented.
//
// T3 Code is running and writing to this file, so it is opened read-only.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Thread {
  id: string
  title: string
  /** the provider, as T3 records it: `antigravity`, `codex`, `opencode` */
  kind: string
  project: string | null
  start: number
  end: number
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
         (SELECT MIN(created_at) FROM projection_thread_messages m WHERE m.thread_id = t.thread_id) AS first_msg,
         (SELECT MAX(created_at) FROM projection_thread_messages m WHERE m.thread_id = t.thread_id) AS last_msg,
         t.created_at AS created_at,
         t.updated_at AS updated_at
    FROM projection_threads t
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
   WHERE t.deleted_at IS NULL
`

function seconds(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? fallback : ms / 1000
}

/**
 * threads that overlap [from, to) and are not Claude.
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
    const rows = db.prepare(SQL).all() as Record<string, unknown>[]
    const out: Thread[] = []
    for (const row of rows) {
      const provider = String(row.provider ?? '')
      if (!provider || provider === 'claudeAgent') continue
      const created = seconds(row.created_at, 0)
      const start = seconds(row.first_msg, created)
      const end = seconds(row.last_msg, seconds(row.updated_at, start))
      if (end < from || start >= to) continue
      out.push({
        id: String(row.id),
        title: String(row.title ?? 'untitled'),
        kind: provider,
        project: row.project === null || row.project === undefined ? null : String(row.project),
        start,
        end,
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
