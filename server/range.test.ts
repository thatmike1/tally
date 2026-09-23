// the range split and the range lanes: pieces per block and per week, summed
// rather than subtracted across a reset, and the same figures as the block
// split where the range is one block.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { LANE_GAP } from './history-types'
import type { Family } from './prices'
import {
  fiveHourPieces,
  MAX_RANGE,
  meterPoints,
  parseRange,
  rangeLanes,
  rangeSplit,
  resolutionFor,
  splitRange,
  weeklyPieces,
  type RangeLanes,
  type RangeSplit,
} from './range'
import type { Sample } from './samples'
import { splitBlock, WEEK, type Reading } from './split'
import { buildState } from './state'
import { TranscriptIndex } from './transcript-index'
import { projectsRoot, type RequestRecord, type SessionMeta } from './transcripts'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
/** the fixture session with two subagent transcripts under it */
const WITH_AGENTS = '6540615c-78fa-4cce-ad83-291217cfc6ae'
/** three fixture blocks hold requests: resets 1789039200, 1789057200 and 1789075200 */
const RANGE_FROM = 1789026011
const RANGE_TO = 1789072726
/** inside the middle block's span, after its last sample and before the next block's first */
const MIDDLE_AT = 1789057100

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sample(t: number, pct: number, resetKey: number, weeklyPct: number | null = null, weeklyResetsAt: number | null = null): Sample {
  return {
    t,
    pct,
    resetsAt: resetKey,
    resetKey,
    weeklyPct,
    weeklyResetsAt,
    scoped: [],
    extra: null,
    otherLimits: [],
    rawExtra: {},
    unknown: {},
  }
}

function request(sessionId: string, t: number, cost: number, family: Family = 'opus'): RequestRecord {
  return {
    t,
    file: `/p/${sessionId}.jsonl`,
    mid: `msg-${sessionId}-${t}`,
    project: 'p',
    sessionId,
    agent: false,
    model: `claude-${family}-5`,
    family,
    priced: true,
    cost,
    effort: 'high',
    in: 0,
    cw1h: 0,
    cw5m: 0,
    cr: cost * 1e6,
    out: 0,
  }
}

const metas = new Map<string, SessionMeta>([
  ['a', { sessionId: 'a', project: 'p', title: 'session a', modified: 0 }],
  ['b', { sessionId: 'b', project: 'p', title: 'session b', modified: 0 }],
])

// two blocks: A resets at 1000 and was read 10 -> 30, B resets at 20000 and was read 5 -> 25
const samples = [sample(100, 10, 1000), sample(500, 30, 1000), sample(1200, 5, 20000), sample(1500, 25, 20000)]
const records = [
  request('a', 200, 3),
  request('b', 300, 1),
  // between A's last reading and B's first: no reading measured it
  request('a', 1100, 1),
  request('b', 1300, 2),
]

describe('fiveHourPieces', () => {
  it('cuts a range across a reset into one piece per block, and the movement adds up', () => {
    const pieces = fiveHourPieces(samples, 0, 2000)
    expect(pieces.map((p) => [p.resetsAt, p.from, p.to, p.delta])).toEqual([
      [1000, 100, 500, 20],
      [20000, 1200, 1500, 20],
    ])
    // last reading minus first would say -5; the meter really moved 40
    const split = splitRange(records, metas, pieces, 0, 2000)
    expect(split.delta).toBe(40)
  })

  it('keeps a block that the range holds a single reading of, as a piece that measured nothing', () => {
    const pieces = fiveHourPieces(samples, 400, 1300)
    expect(pieces.map((p) => p.delta)).toEqual([null, null])
    expect(splitRange(records, metas, pieces, 400, 1300).delta).toBeNull()
  })
})

describe('splitRange', () => {
  it('divides each block over its own requests, and shares the range by cost', () => {
    const split = splitRange(records, metas, fiveHourPieces(samples, 0, 2000), 0, 2000)
    const byId = new Map(split.sessions.map((row) => [row.sessionId, row]))
    // A: a 3 and b 1 share 20 points; B: b alone takes 20
    expect(byId.get('a')!.points).toBeCloseTo(15, 10)
    expect(byId.get('b')!.points).toBeCloseTo(5 + 20, 10)
    // shares are the range's cost, the unmeasured request included
    expect(byId.get('a')!.share).toBeCloseTo(4 / 7, 10)
    expect(byId.get('b')!.share).toBeCloseTo(3 / 7, 10)
    expect(split.costUnmeasured).toBeCloseTo(1, 10)
    expect(split.pointsUnattributed).toBe(0)
    expect(split.totalCost).toBe(7)
    expect(split.usage.cost).toBe(7)
    expect(split.usage.requests).toBe(4)
  })

  it('gives the block split its own figures when the range is one block\'s sampled span', () => {
    const range = splitRange(records, metas, fiveHourPieces(samples, 100, 500), 100, 500)
    const block = splitBlock(records, metas, { from: 100, to: 500, delta: 20 })
    expect(range.delta).toBe(block.delta)
    expect(range.sessions.map((r) => [r.sessionId, r.share, r.points])).toEqual(
      block.sessions.map((r) => [r.sessionId, r.share, r.points]),
    )
    expect(range.usage).toEqual(block.usage)
  })

  it('returns rows and usage but null deltas and points where nothing was measured', () => {
    const split = splitRange(records, metas, [], 0, 2000)
    expect(split.delta).toBeNull()
    expect(split.pointsUnattributed).toBeNull()
    expect(split.sessions.length).toBe(2)
    expect(split.sessions.every((row) => row.points === null)).toBe(true)
    expect(split.usage.requests).toBe(4)
    expect(split.costUnmeasured).toBe(7)
  })

  it('says how much measured movement had no local request to divide it over', () => {
    const quiet = [sample(3000, 1, 5000), sample(3600, 4, 5000)]
    const split = splitRange(records, metas, fiveHourPieces([...samples, ...quiet], 0, 4000), 0, 4000)
    expect(split.delta).toBe(43)
    expect(split.pointsUnattributed).toBe(3)
    // a measured zero is a measurement, not a missing one
    const flat = splitRange([], metas, fiveHourPieces([sample(3000, 4, 5000), sample(3600, 4, 5000)], 0, 4000), 0, 4000)
    expect(flat.delta).toBe(0)
  })
})

describe('weeklyPieces', () => {
  const reset = 2_000_000
  const opens = reset - WEEK
  const readings: Reading[] = [
    { t: opens + 3600, pct: 5, resetsAt: reset },
    { t: opens + 7200, pct: 4, resetsAt: reset + 1 },
    { t: opens + 9000, pct: 9, resetsAt: reset },
    { t: reset + 600, pct: 2, resetsAt: reset + WEEK },
    { t: reset + 1200, pct: 3, resetsAt: reset + WEEK },
  ]

  it('opens a week at 0 when its reset is inside the range, drops a stale reading, and sums across the reset', () => {
    const pieces = weeklyPieces(readings, opens - 60, reset + 3600)
    expect(pieces.map((p) => [p.from, p.startPct, p.endPct, p.delta])).toEqual([
      [opens, 0, 9, 9],
      [reset, 0, 3, 3],
    ])
  })

  it('starts at the first reading inside the range when the reset is outside it', () => {
    const pieces = weeklyPieces(readings, opens + 3000, opens + 10_000)
    expect(pieces.map((p) => [p.from, p.startPct, p.delta])).toEqual([[opens + 3600, 5, 4]])
  })
})

describe('meterPoints and resolutionFor', () => {
  it('keeps LANE_GAP up to a week and coarsens past it', () => {
    expect(resolutionFor(86400)).toBe(LANE_GAP)
    expect(resolutionFor(7 * 86400)).toBeLessThanOrEqual(LANE_GAP + 3)
    expect(resolutionFor(30 * 86400)).toBe(Math.ceil((30 * 86400) / 2000))
  })

  it('keeps every block\'s first sample and the last one per step', () => {
    const many = [
      sample(0, 1, 18000),
      sample(100, 2, 18000),
      sample(200, 3, 18000),
      sample(1100, 4, 18000),
      sample(1200, 0, 40000),
      sample(1300, 1, 40000),
    ]
    const points = meterPoints(many, 0, 2000, 1000, null)
    expect(points.map((p) => [p.t, p.pct])).toEqual([
      [0, 1],
      [200, 3],
      [1100, 4],
      [1200, 0],
      [1300, 1],
    ])
  })
})

describe('parseRange', () => {
  it('rejects what is not a range', () => {
    expect(() => parseRange(undefined, '10')).toThrow(/unix seconds/)
    expect(() => parseRange('x', '10')).toThrow(/unix seconds/)
    expect(() => parseRange('10', '10')).toThrow(/after/)
    expect(() => parseRange('0', String(MAX_RANGE + 1))).toThrow(/at most/)
    expect(parseRange('10', '20')).toEqual({ from: 10, to: 20 })
  })
})

/** the fixture home with a T3 db that ran one of its sessions */
function homeWithT3(): string {
  const home = mkdtempSync(join(tmpdir(), 'tally-range-'))
  temps.push(home)
  cpSync(FIXTURE_HOME, home, { recursive: true })
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true })
  const db = new DatabaseSync(join(home, '.t3', 'userdata', 'state.sqlite'))
  db.exec(`
    CREATE TABLE projection_threads (thread_id TEXT, title TEXT, project_id TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
  `)
  db.prepare('INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?)').run('t-1', 'Fixture Fan-out', 'p-1', '', '')
  db.prepare('INSERT INTO provider_session_runtime VALUES (?, ?, ?)').run(
    't-1',
    'claudeAgent',
    JSON.stringify({ threadId: 't-1', resume: WITH_AGENTS, turnCount: 3 }),
  )
  db.close()
  return home
}

describe('rangeSplit over the fixture home', () => {
  it('matches the frozen block split when the range is that block\'s sampled span', async () => {
    const state = await buildState({ home: FIXTURE_HOME, at: MIDDLE_AT, recordLook: false, weekMode: 'whole' })
    const block = state.split!
    expect(block.sessions.length).toBeGreaterThan(0)
    const range = await rangeSplit(block.from, block.to, { home: FIXTURE_HOME, now: MIDDLE_AT })
    expect(range.fiveHour.delta).toBe(block.delta)
    const byId = new Map(range.fiveHour.sessions.map((row) => [row.sessionId, row]))
    for (const row of block.sessions) {
      expect(byId.get(row.sessionId)!.points).toBeCloseTo(row.points!, 10)
      expect(byId.get(row.sessionId)!.share).toBeCloseTo(row.share, 10)
      expect(byId.get(row.sessionId)!.models).toEqual(row.models)
    }
    expect(range.fiveHour.usage).toEqual(block.usage)
  })

  it('sums three blocks across two resets, and its rows add up to its usage', async () => {
    const range = await rangeSplit(RANGE_FROM, RANGE_TO, { home: FIXTURE_HOME, now: RANGE_TO })
    const pieces = range.fiveHour.pieces
    expect(pieces.length).toBe(3)
    expect(range.fiveHour.delta).toBe(pieces.reduce((sum, p) => sum + (p.delta ?? 0), 0))
    const rows = range.fiveHour.sessions
    expect(rows.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(range.fiveHour.usage.cost, 10)
    expect(rows.reduce((sum, r) => sum + r.requests, 0)).toBe(range.fiveHour.usage.requests)
    expect(rows.reduce((sum, r) => sum + r.buckets.cr, 0)).toBe(range.fiveHour.usage.buckets.cr)
    // every measured point went to someone or is reported as unattributed
    const points = rows.reduce((sum, r) => sum + (r.points ?? 0), 0)
    expect(points + range.fiveHour.pointsUnattributed!).toBeCloseTo(range.fiveHour.delta!, 8)
    expect(range.weekly.delta).not.toBeNull()
    expect(range.weekly.sessions.length).toBe(rows.length)
  })

  it('names a session T3 ran by its thread title', async () => {
    const home = homeWithT3()
    const range = await rangeSplit(RANGE_FROM, RANGE_TO, { home, now: RANGE_TO })
    const row = range.fiveHour.sessions.find((r) => r.sessionId === WITH_AGENTS)!
    expect(row.shortTitle).toBe('Fixture Fan-out')
    expect(range.fiveHour.sessions.filter((r) => r.sessionId !== WITH_AGENTS).every((r) => r.shortTitle === null)).toBe(true)
    const state = await buildState({ home, at: MIDDLE_AT, recordLook: false })
    expect(state.split!.sessions.find((r) => r.sessionId === WITH_AGENTS)!.shortTitle).toBe('Fixture Fan-out')
    const lanes = await rangeLanes(RANGE_FROM, RANGE_TO, { home, now: RANGE_TO })
    expect(lanes.lanes.find((lane) => lane.id === WITH_AGENTS)!.shortTitle).toBe('Fixture Fan-out')
  })
})

describe('GET /api/split and /api/lanes', () => {
  const app = (index?: TranscriptIndex) => createApp({ home: FIXTURE_HOME, now: RANGE_TO, index, recordLook: false })

  it('answers 400 for a range that is not one', async () => {
    for (const query of ['', '?from=1', '?from=5&to=1', `?from=0&to=${MAX_RANGE + 1}`]) {
      expect((await app().request(`/api/split${query}`)).status).toBe(400)
      expect((await app().request(`/api/lanes${query}`)).status).toBe(400)
    }
  })

  it('splits a range the same off the index as off the transcripts', async () => {
    const index = new TranscriptIndex({ root: projectsRoot(FIXTURE_HOME), path: ':memory:' })
    await index.refresh()
    const url = `/api/split?from=${RANGE_FROM}&to=${RANGE_TO}`
    const fromIndex = (await (await app(index).request(url)).json()) as RangeSplit
    const fromScan = (await (await app().request(url)).json()) as RangeSplit
    expect(fromIndex.fiveHour).toEqual(fromScan.fiveHour)
    expect(fromIndex.fiveHour.sessions.some((row) => row.effort.some((e) => e.effort !== null))).toBe(true)
    index.close()
  })

  it('draws the lanes and meter of any window', async () => {
    const response = await app().request(`/api/lanes?from=${RANGE_FROM}&to=${RANGE_TO}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as RangeLanes
    expect(body.resolution).toBe(LANE_GAP)
    expect(body.lanes.length).toBeGreaterThan(0)
    expect(body.lanes.every((lane) => lane.start >= RANGE_FROM && lane.end < RANGE_TO)).toBe(true)
    expect(body.meter.length).toBeGreaterThan(10)
    expect(body.meter.every((p) => p.t >= RANGE_FROM && p.t < RANGE_TO)).toBe(true)
    expect(body.scopedModel).toBe('Fable')
  })
})
