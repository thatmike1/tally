// a Codex lane under the chart picks up its thread's share of the Codex week by
// T3's thread id, which both sides carry, never by title
import { describe, expect, it } from 'vitest'
import type { Lane } from '../api'
import { buildGroups, type CodexThread } from './timeline-lanes'

const lane = (id: string, title: string): Lane => ({
  id,
  kind: 'codex',
  title,
  shortTitle: null,
  project: '/home/me/git/tally',
  start: 100,
  end: 200,
  live: false,
  cost: null,
  tokens: null,
  requests: 0,
  agents: 0,
  segments: [{ start: 100, end: 200, cost: 0, requests: 0, agents: 0 }],
})

const thread = (id: string, t3ThreadId: string | null, title: string, credits: number): CodexThread => ({
  id,
  t3ThreadId,
  title,
  via: 't3',
  project: 'tally',
  credits,
  share: 0.5,
  points: 1,
  calls: 3,
  subagents: 0,
  models: ['gpt-6.1-sol'],
  unpriced: false,
  start: 100,
  end: 200,
  live: false,
  color: '#3c6e9e',
})

const rowsOf = (lanes: Lane[], codex: CodexThread[]) =>
  buildGroups(lanes, null, { from: 0, to: 1000 }, codex).flatMap((group) => group.rows)

describe('buildGroups codex match', () => {
  it('matches a lane to the thread T3 resumes, even after a rename', () => {
    const rows = rowsOf([lane('t3-a', 'renamed in T3')], [thread('codex-a', 't3-a', 'old title', 40)])
    expect(rows[0]?.codex?.id).toBe('codex-a')
  })

  it('keeps two threads with the same title apart', () => {
    const rows = rowsOf(
      [lane('t3-a', 'Review'), lane('t3-b', 'Review')],
      [thread('codex-a', 't3-a', 'Review', 40), thread('codex-b', 't3-b', 'Review', 7)],
    )
    expect(rows.map((row) => [row.id, row.codex?.id])).toEqual([
      ['t3-a', 'codex-a'],
      ['t3-b', 'codex-b'],
    ])
  })

  it('leaves a lane without a T3 match empty rather than guessing by title', () => {
    const rows = rowsOf([lane('t3-a', 'Review')], [thread('codex-x', null, 'Review', 40)])
    expect(rows[0]?.codex).toBeNull()
  })
})
