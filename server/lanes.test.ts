// the lanes: activity, not span.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LANE_GAP } from './history-types'
import { buildLanes, projectPath, segmentsOf } from './lanes'
import type { Thread } from './t3'
import type { RequestRecord, SessionMeta } from './transcripts'

const PROJECT = '-home-thatmike1-git-tally'
const LEAD = `/home/thatmike1/.claude/projects/${PROJECT}/s1.jsonl`
const AGENT_A = `/home/thatmike1/.claude/projects/${PROJECT}/s1/subagents/agent-a.jsonl`
const AGENT_B = `/home/thatmike1/.claude/projects/${PROJECT}/s1/subagents/agent-b.jsonl`

function record(t: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    t,
    file: LEAD,
    mid: `m${t}`,
    project: PROJECT,
    sessionId: 's1',
    agent: false,
    model: 'claude-opus-5',
    family: 'opus',
    priced: true,
    cost: 1,
    effort: null,
    in: 10,
    cw1h: 0,
    cw5m: 0,
    cr: 90,
    out: 5,
    ...over,
  }
}

function meta(over: Partial<SessionMeta> = {}): Map<string, SessionMeta> {
  return new Map([
    ['s1', { sessionId: 's1', project: PROJECT, title: 'the session', modified: 1000, cwd: null, ...over }],
  ])
}

/** a stand-in filesystem: only these directories exist */
function onDisk(paths: string[]): (path: string) => boolean {
  const set = new Set(paths)
  return (path) => set.has(path)
}

describe('projectPath', () => {
  const temps: string[] = []
  afterAll(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('takes the cwd a transcript line carried, whatever the encoded name says', () => {
    expect(projectPath('-home-thatmike1-git-ccChat-general', '/srv/somewhere else')).toBe('/srv/somewhere else')
  })

  it('resolves a hyphenated directory against the filesystem instead of splitting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-lanes-'))
    temps.push(dir)
    const project = join(dir, 'ccChat-general')
    mkdirSync(project)
    // the encoding Claude writes: every slash in the real path becomes a dash
    expect(projectPath(project.replace(/\//g, '-'), null)).toBe(project)

    // and the same walk with a stand-in filesystem, where only the long name exists
    const encoded = '-home-thatmike1-git-ccChat-general'
    const tree = ['/home', '/home/thatmike1', '/home/thatmike1/git', '/home/thatmike1/git/ccChat-general']
    expect(projectPath(encoded, null, onDisk(tree))).toBe('/home/thatmike1/git/ccChat-general')
    // a plain name still decodes, and the longest match wins over a shorter one
    expect(projectPath('-home-thatmike1-git-tally', null, onDisk([...tree, '/home/thatmike1/git/tally']))).toBe(
      '/home/thatmike1/git/tally',
    )
  })

  it('hands back the encoded name when no path on disk matches it', () => {
    const encoded = '-home-thatmike1-git-deleted-project'
    expect(projectPath(encoded, null, onDisk(['/home', '/home/thatmike1', '/home/thatmike1/git']))).toBe(encoded)
    expect(projectPath(encoded, null, onDisk([]))).toBe(encoded)
    // an already-decoded path is left alone
    expect(projectPath('/home/thatmike1/git/tally', null, onDisk([]))).toBe('/home/thatmike1/git/tally')
  })
})

describe('segmentsOf', () => {
  it('merges requests up to LANE_GAP apart and breaks past it', () => {
    const merged = segmentsOf([record(0), record(LANE_GAP), record(LANE_GAP * 2)])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ start: 0, end: LANE_GAP * 2, requests: 3 })

    const split = segmentsOf([record(0), record(LANE_GAP + 1)])
    expect(split).toHaveLength(2)
    expect(split.map((s) => s.start)).toEqual([0, LANE_GAP + 1])
    expect(split.every((s) => s.start === s.end)).toBe(true)
  })

  it('counts the distinct subagent files inside each segment, and only those', () => {
    const segments = segmentsOf([
      record(0),
      record(10, { file: AGENT_A, agent: true }),
      record(20, { file: AGENT_A, agent: true, mid: 'again' }),
      record(30, { file: AGENT_B, agent: true }),
      // a sidechain line in the lead file is an agent record but not another transcript
      record(40, { agent: true, mid: 'sidechain' }),
      // a new segment starts over: its agent count does not inherit the last one's
      record(40 + LANE_GAP + 1),
    ])
    expect(segments).toHaveLength(2)
    expect(segments[0]!.agents).toBe(2)
    expect(segments[1]!.agents).toBe(0)
  })

  it('sums cost per segment and leaves the order of the input alone', () => {
    const input = [record(30, { cost: 3 }), record(0, { cost: 1 }), record(10, { cost: 2 })]
    const segments = segmentsOf(input)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.cost).toBe(6)
    expect(input.map((r) => r.t)).toEqual([30, 0, 10])
  })
})

describe('buildLanes', () => {
  const base = { sessions: meta(), threads: [] as Thread[], from: 0, to: 10_000, now: 1000 }

  it('gives a Claude session one lane of segments, with its cost and tokens', () => {
    const [lane] = buildLanes({
      ...base,
      records: [record(0), record(10, { file: AGENT_A, agent: true }), record(5000)],
    })
    expect(lane!.kind).toBe('claude')
    expect(lane!.title).toBe('the session')
    expect(lane!.segments).toHaveLength(2)
    expect(lane!.agents).toBe(1)
    expect(lane!.requests).toBe(3)
    expect(lane!.cost).toBe(3)
    expect(lane!.tokens).toBe(3 * 105)
    expect(lane!.start).toBe(0)
    expect(lane!.end).toBe(5000)
    expect(lane!.live).toBe(true)
  })

  it('counts only the requests inside the window', () => {
    const lanes = buildLanes({ ...base, records: [record(-1), record(5), record(10_000)] })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]!.requests).toBe(1)
  })

  it('takes the cwd as the project when a line carried one, else decodes the directory', () => {
    const [withCwd] = buildLanes({
      ...base,
      sessions: meta({ cwd: '/home/thatmike1/git/tally' }),
      records: [record(0)],
    })
    expect(withCwd!.project).toBe('/home/thatmike1/git/tally')
    const tree = ['/home', '/home/thatmike1', '/home/thatmike1/git', '/home/thatmike1/git/tally']
    const [without] = buildLanes({ ...base, records: [record(0)], exists: onDisk(tree) })
    expect(without!.project).toBe('/home/thatmike1/git/tally')
  })

  it("draws a thread's stretches of activity and no cost, never an invented number", () => {
    const thread: Thread = {
      id: 't-1',
      title: 'an antigravity thread',
      kind: 'antigravity',
      project: 'tally',
      start: 100,
      end: 900,
      began: null,
      segments: [
        { start: 100, end: 200 },
        { start: 800, end: 900 },
      ],
      live: true,
    }
    const lanes = buildLanes({ ...base, records: [record(0)], threads: [thread] })
    const other = lanes.find((lane) => lane.kind === 'antigravity')!
    expect(other.cost).toBeNull()
    expect(other.tokens).toBeNull()
    expect(other.requests).toBe(0)
    // the idle stretch between the two is not drawn as work
    expect(other.segments).toEqual([
      { start: 100, end: 200, cost: 0, requests: 0, agents: 0 },
      { start: 800, end: 900, cost: 0, requests: 0, agents: 0 },
    ])
    // oldest first, whatever kind it is
    expect(lanes.map((lane) => lane.start)).toEqual([0, 100])
  })

  it('drops a thread with nothing inside the window', () => {
    const thread: Thread = {
      id: 't-2',
      title: 'yesterday',
      kind: 'codex',
      project: null,
      start: -500,
      end: -100,
      began: -500,
      segments: [],
      live: false,
    }
    expect(buildLanes({ ...base, records: [], threads: [thread] })).toEqual([])
  })

  it('calls a session live only while its transcript is still being written', () => {
    const [stale] = buildLanes({ ...base, records: [record(0)], now: 100_000 })
    expect(stale!.live).toBe(false)
  })
})
