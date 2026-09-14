// the split math, the projection, and the provisional weekly rule.
import { describe, expect, it } from 'vitest'
import type { Family } from './prices'
import type { Sample } from './samples'
import {
  dailyDeltas,
  median,
  project,
  splitBlock,
  splitFable,
  splitWeekly,
  WEEKLY_POINTS_PER_DOLLAR,
  weekWindow,
  weeklyVerdict,
  type Reading,
} from './split'
import type { RequestRecord, SessionMeta } from './transcripts'

function request(sessionId: string, t: number, cost: number, agent = false, family: Family = 'opus'): RequestRecord {
  return {
    t,
    file: agent ? `/p/${sessionId}/subagents/agent-${t}.jsonl` : `/p/${sessionId}.jsonl`,
    mid: `msg-${sessionId}-${t}`,
    project: 'p',
    sessionId,
    agent,
    model: `claude-${family}-5`,
    family,
    priced: true,
    cost,
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
  ['c', { sessionId: 'c', project: 'p', title: 'session c', modified: 0 }],
])

describe('splitBlock', () => {
  const records = [
    request('a', 100, 6),
    request('a', 150, 2, true),
    request('a', 160, 2, true),
    request('b', 120, 2),
  ]

  it('divides the measured delta by list-price cost, ranked by share', () => {
    const split = splitBlock(records, metas, { from: 50, to: 200, delta: 40 })
    expect(split.totalCost).toBe(12)
    expect(split.sessions.map((s) => s.sessionId)).toEqual(['a', 'b'])
    expect(split.sessions[0]!.share).toBeCloseTo(10 / 12, 10)
    expect(split.sessions[0]!.points).toBeCloseTo((10 / 12) * 40, 10)
    expect(split.sessions[1]!.points).toBeCloseTo((2 / 12) * 40, 10)
    expect(split.sessions.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10)
  })

  it('folds subagent files into the parent and counts them', () => {
    const split = splitBlock(records, metas, { from: 50, to: 200, delta: 40 })
    expect(split.sessions[0]!.subagents).toBe(2)
    expect(split.sessions[0]!.requests).toBe(3)
    expect(split.sessions[1]!.subagents).toBe(0)
  })

  it('shows no points at all when the delta is unknown', () => {
    const split = splitBlock(records, metas, { from: 50, to: 200, delta: null })
    expect(split.sessions.every((s) => s.points === null)).toBe(true)
    // shares are still honest, they do not need a delta
    expect(split.sessions[0]!.share).toBeCloseTo(10 / 12, 10)
  })

  it('counts only the observed window, and reports what fell outside it', () => {
    const split = splitBlock(records, metas, { from: 130, to: 155, delta: 10, blockStart: 0 })
    expect(split.sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(split.totalCost).toBe(2)
    expect(split.costBeforeFirstSample).toBe(8)
    expect(split.costAfterLastSample).toBe(2)
  })

  it("keeps the session's own span", () => {
    const split = splitBlock(records, metas, { from: 50, to: 200, delta: 40 })
    expect(split.sessions[0]!.start).toBe(100)
    expect(split.sessions[0]!.end).toBe(160)
  })

  it('gives every session a zero share when nothing cost anything', () => {
    const free = [request('a', 100, 0)]
    const split = splitBlock(free, metas, { from: 50, to: 200, delta: 40 })
    expect(split.sessions[0]!.share).toBe(0)
    expect(split.sessions[0]!.points).toBeNull()
  })
})

describe('weekWindow', () => {
  const midnight = 1000
  const reset = 500_000
  const read = (...ts: number[]): Reading[] => ts.map((t) => ({ t, pct: 50, resetsAt: reset }))

  it('runs from the last look when the look is inside this weekly period', () => {
    expect(weekWindow(9000, 2000, reset, read(2100, 2400), midnight)).toEqual({ from: 2000, to: 9000, since: 'lastLooked' })
    // yesterday still counts, as long as the weekly meter has not reset since
    expect(weekWindow(9000, 400, reset, read(), midnight).since).toBe('lastLooked')
  })

  it('falls back to Prague midnight without a look, or with one from a previous week', () => {
    expect(weekWindow(9000, null, reset, read(2100, 2400), midnight)).toEqual({ from: 1000, to: 9000, since: 'today' })
    expect(weekWindow(9000, reset - 8 * 24 * 3600, reset, read(2100, 2400), midnight).since).toBe('today')
  })

  it('falls back to the day when the sampler has not read the meter twice since the look', () => {
    expect(weekWindow(9000, 8800, reset, read(2100, 2400, 8900), midnight).since).toBe('today')
  })
})

describe('splitFable and splitWeekly', () => {
  const reset = 900_000
  const readings = (points: [number, number][]): Reading[] => points.map(([t, pct]) => ({ t, pct, resetsAt: reset }))
  const window = { from: 90, to: 400, since: 'today' as const }
  const records = [
    request('a', 50, 99, false, 'fable'), // before the window
    request('a', 95, 1, false, 'fable'), // in the window, before the first reading
    request('a', 120, 3, false, 'fable'),
    request('a', 130, 10, false, 'opus'),
    request('b', 140, 1, true, 'fable'),
    request('c', 150, 40, false, 'opus'), // the biggest session, and no Fable at all
    request('b', 350, 5, false, 'fable'), // after the last reading
  ]
  const meters = readings([
    [80, 60],
    [100, 62],
    [200, 66],
    [300, 70],
    [410, 90],
  ])

  it('snaps the window to the first and last reading inside it, and measures the delta there', () => {
    const split = splitFable(records, metas, meters, window)!
    expect([split.from, split.to]).toEqual([100, 300])
    expect([split.startPct, split.endPct, split.delta]).toEqual([62, 70, 8])
    expect(split.costBeforeFirstSample).toBe(1)
    expect(split.costAfterLastSample).toBe(5)
  })

  it('divides the Fable meter by Fable cost only, so a session without Fable has no share', () => {
    const split = splitFable(records, metas, meters, window)!
    expect(split.sessions.map((s) => s.sessionId)).toEqual(['a', 'b'])
    expect(split.totalCost).toBe(4)
    expect(split.sessions[0]!.share).toBeCloseTo(3 / 4, 10)
    expect(split.sessions[0]!.cost).toBe(3)
    expect(split.sessions[0]!.points).toBeCloseTo(6, 10)
    expect(split.sessions[1]!.subagents).toBe(1)
  })

  it('divides the weekly meter by cost weighted per family', () => {
    const { opus, fable } = WEEKLY_POINTS_PER_DOLLAR
    const split = splitWeekly(records, metas, meters, window)!
    const weights = { a: 3 * fable + 10 * opus, b: 1 * fable, c: 40 * opus }
    const total = weights.a + weights.b + weights.c
    expect(split.sessions.map((s) => s.sessionId)).toEqual(['c', 'a', 'b'])
    expect(split.sessions[0]!.share).toBeCloseTo(weights.c / total, 10)
    expect(split.sessions[1]!.share).toBeCloseTo(weights.a / total, 10)
    expect(split.sessions[2]!.points).toBeCloseTo((weights.b / total) * 8, 10)
    // the dollars stay list-price dollars; only the division is weighted
    expect(split.sessions[1]!.cost).toBe(13)
    expect(split.totalCost).toBe(54)
  })

  it('treats sonnet and haiku at the opus rate', () => {
    const mixed = [request('a', 120, 10, false, 'sonnet'), request('c', 130, 10, false, 'haiku')]
    const split = splitWeekly(mixed, metas, meters, window)!
    expect(split.sessions.map((s) => s.share)).toEqual([0.5, 0.5])
  })

  it('shows shares but no points when the meter did not move', () => {
    const flat = readings([
      [100, 70],
      [300, 70],
    ])
    const split = splitFable(records, metas, flat, window)!
    expect(split.delta).toBe(0)
    expect(split.sessions.every((s) => s.points === null)).toBe(true)
    expect(split.sessions[0]!.share).toBeCloseTo(3 / 4, 10)
  })

  it('splits nothing when the window crossed the weekly reset', () => {
    const crossed = readings([
      [100, 95],
      [300, 3],
    ])
    const split = splitWeekly(records, metas, crossed, window)!
    expect(split.crossedReset).toBe(true)
    expect(split.sessions).toEqual([])
    expect(split.delta).toBeNull()
    expect([split.startPct, split.endPct]).toEqual([95, 3])
  })

  it('catches a reset the meter climbed back over, by the reset time moving', () => {
    const climbed: Reading[] = [
      { t: 100, pct: 2, resetsAt: reset },
      { t: 300, pct: 9, resetsAt: reset + 7 * 24 * 3600 },
    ]
    expect(splitFable(records, metas, climbed, window)!.crossedReset).toBe(true)
  })

  it('has nothing to say about a window the sampler never read', () => {
    expect(splitWeekly(records, metas, readings([[80, 60]]), window)).toBeNull()
  })
})

describe('project', () => {
  const sample = (t: number, pct: number) => ({ t, pct }) as Sample

  it('carries the block pace to the reset', () => {
    // 10 points per 1000s, 2000s of block left
    const projection = project(sample(0, 10), sample(1000, 20), 3000)
    expect(projection.pace).toBeCloseTo(0.01, 10)
    expect(projection.pctAtReset).toBeCloseTo(40, 10)
    expect(projection.hitsHundredAt).toBeNull()
  })

  it('says when the meter runs out instead of projecting past 100', () => {
    const projection = project(sample(0, 50), sample(1000, 70), 10_000)
    expect(projection.pctAtReset).toBe(100)
    expect(projection.hitsHundredAt).toBe(1000 + 30 / 0.02)
  })

  it('has no pace from a single sample', () => {
    const projection = project(sample(0, 50), sample(0, 50), 10_000)
    expect(projection.pace).toBe(0)
    expect(projection.pctAtReset).toBe(50)
  })
})

describe('dailyDeltas', () => {
  const at = (iso: string, weekly: number) => ({ t: Date.parse(iso) / 1000, weeklyPct: weekly }) as Sample

  it('measures each Prague day first to last', () => {
    const deltas = dailyDeltas(
      [at('2026-09-07T08:00:00+02:00', 10), at('2026-09-07T20:00:00+02:00', 24), at('2026-09-08T09:00:00+02:00', 30)],
      (s) => s.weeklyPct,
    )
    expect(deltas.map((d) => [d.day, d.delta])).toEqual([
      ['2026-09-07', 14],
      ['2026-09-08', 0],
    ])
  })

  it('drops a day that crossed the weekly reset rather than clamping it', () => {
    const deltas = dailyDeltas([at('2026-09-07T08:00:00+02:00', 90), at('2026-09-07T23:00:00+02:00', 4)], (s) => s.weeklyPct)
    expect(deltas).toEqual([])
  })

  it('marks the weekend, which the verdict treats as free burn', () => {
    // 4 September 2026 is a Friday, the 5th a Saturday
    const deltas = dailyDeltas([at('2026-09-04T08:00:00+02:00', 1), at('2026-09-05T08:00:00+02:00', 2)], (s) => s.weeklyPct)
    expect(deltas.map((d) => d.weekend)).toEqual([false, true])
  })
})

describe('weeklyVerdict', () => {
  // Friday 11 Sep 2026, 12:00 Prague; the weekly meter resets Saturday 23:00
  const now = Date.parse('2026-09-11T12:00:00+02:00') / 1000
  const reset = Date.parse('2026-09-12T23:00:00+02:00') / 1000

  it('is on pace when every remaining workday fits', () => {
    // reset next Wednesday: Fri, Mon, Tue, Wed still to pay for
    const later = Date.parse('2026-09-16T23:00:00+02:00') / 1000
    expect(weeklyVerdict(50, later, now, [10, 10, 10], null).phrase).toBe('on pace')
    expect(weeklyVerdict(70, later, now, [10, 10, 10], null).phrase).toBe('a full day fits')
  })

  it('counts only the weekdays left, so a weekend is free burn', () => {
    expect(weeklyVerdict(50, reset, now, [10, 10, 10], null).workdaysLeft).toBe(1)
  })

  it('names the model when a full day still fits', () => {
    expect(weeklyVerdict(87, reset, now, [10, 12, 14], 'Fable').phrase).toBe('a full Fable day fits')
  })

  it('drops to one light day, then to over pace', () => {
    expect(weeklyVerdict(90, reset, now, [10, 20, 20], null).phrase).toBe('one light day left')
    expect(weeklyVerdict(99, reset, now, [10, 20, 20], null).phrase).toBe('over pace')
  })

  it('falls back to the bare number with no history to lean on', () => {
    expect(weeklyVerdict(40, reset, now, [], null).phrase).toBe('60 points left')
  })
})

describe('median', () => {
  it('averages the middle pair', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([])).toBeNull()
  })
})
