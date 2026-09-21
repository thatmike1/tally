// T3 threads as activity: the db keeps one row per message, and a thread poked
// on three different days must come back as three stretches, not one long bar.
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { otherThreads, segmentsOfTimes } from './t3'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const iso = (t: number) => new Date(t * 1000).toISOString()

interface ThreadFixture {
  id: string
  title?: string
  provider?: string | null
  activeTurn?: string | null
  created: number
  updated: number
  messages: number[]
}

/** a state.sqlite with only the columns `otherThreads` reads */
function stateDb(threads: ThreadFixture[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tally-t3-'))
  temps.push(dir)
  const path = join(dir, 'state.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE projection_threads (thread_id TEXT, title TEXT, project_id TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT, provider_name TEXT, status TEXT, active_turn_id TEXT);
    CREATE TABLE projection_projects (project_id TEXT, title TEXT);
    CREATE TABLE projection_thread_messages (thread_id TEXT, created_at TEXT);
    INSERT INTO projection_projects VALUES ('p-1', 'tally');
  `)
  for (const thread of threads) {
    db.prepare('INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?)').run(
      thread.id,
      thread.title ?? 'a thread',
      'p-1',
      iso(thread.created),
      iso(thread.updated),
    )
    db.prepare('INSERT INTO projection_thread_sessions VALUES (?, ?, ?, ?)').run(
      thread.id,
      thread.provider ?? 'codex',
      'ready',
      thread.activeTurn ?? null,
    )
    for (const t of thread.messages) {
      db.prepare('INSERT INTO projection_thread_messages VALUES (?, ?)').run(thread.id, iso(t))
    }
  }
  db.close()
  return path
}

describe('segmentsOfTimes', () => {
  it('merges what is close and breaks on the idle stretch', () => {
    expect(segmentsOfTimes([0, 60, 120, 5000, 5100], 300)).toEqual([
      { start: 0, end: 120 },
      { start: 5000, end: 5100 },
    ])
  })

  it('gives a lone message a mark, not a span', () => {
    expect(segmentsOfTimes([42])).toEqual([{ start: 42, end: 42 }])
  })

  it('has nothing to say about no messages', () => {
    expect(segmentsOfTimes([])).toEqual([])
  })
})

describe('otherThreads', () => {
  it('splits a thread poked over three days into its stretches', () => {
    const day = 86_400
    const path = stateDb([
      { id: 't-1', created: 0, updated: 2 * day + 120, messages: [0, 30, day, day + 60, 2 * day, 2 * day + 120] },
    ])
    const [thread] = otherThreads(-day, 3 * day, path)
    expect(thread!.segments).toEqual([
      { start: 0, end: 30 },
      { start: day, end: day + 60 },
      { start: 2 * day, end: 2 * day + 120 },
    ])
    // the span is still there for the axis; the working time is the segments
    expect(thread!.start).toBe(0)
    expect(thread!.end).toBe(2 * day + 120)
    expect(thread!.began).toBeNull()
  })

  it('keeps only the window, and says the thread is older than it', () => {
    const day = 86_400
    const path = stateDb([{ id: 't-1', created: 0, updated: day + 60, messages: [0, 30, day, day + 60] }])
    const [thread] = otherThreads(day - 100, day + 3600, path)
    expect(thread!.segments).toEqual([{ start: day, end: day + 60 }])
    expect(thread!.began).toBe(0)
  })

  it('drops a thread with no message inside the window', () => {
    const path = stateDb([{ id: 't-1', created: 0, updated: 100, messages: [0, 100] }])
    expect(otherThreads(10_000, 20_000, path)).toEqual([])
  })

  it('marks a thread that has no messages at its last update, and never spans to it', () => {
    const path = stateDb([{ id: 't-1', created: 0, updated: 9_000, messages: [] }])
    const [thread] = otherThreads(0, 20_000, path)
    expect(thread!.segments).toEqual([{ start: 9_000, end: 9_000 }])
  })

  it('leaves Claude threads to the split, which has real numbers for them', () => {
    const path = stateDb([{ id: 't-1', provider: 'claudeAgent', created: 0, updated: 100, messages: [50] }])
    expect(otherThreads(0, 1000, path)).toEqual([])
  })

  it('calls a thread live only with a turn in flight', () => {
    const path = stateDb([
      { id: 't-1', created: 0, updated: 100, messages: [50] },
      { id: 't-2', created: 0, updated: 100, activeTurn: 'turn-9', messages: [60] },
    ])
    expect(otherThreads(0, 1000, path).map((thread) => thread.live)).toEqual([false, true])
  })
})
