// the split, the projection and the weekly verdict.
//
// the split rule comes from `projects/tally/attribution-proof.md` and is not
// negotiable: no mapping from tokens to 5-hour points exists (0.74 to 1.82
// points per list dollar across six blocks), so the page divides the delta it
// measured, in proportion to list-price cost, and headlines the *share*. a
// points figure is a rounded convenience with a caveat beside it, and there is
// none at all for a window whose delta is unknown.
import type { RequestRecord, SessionMeta } from './transcripts'
import { isWeekend, dayKey, workdaysBetween } from './time'
import type { Family } from './prices'
import type { Sample } from './samples'

/** shown wherever a points figure appears */
export const CAVEAT =
  'Split by list-price cost across the block’s measured jump. Approximate to about a quarter of each figure.'

export interface SessionSplit {
  sessionId: string
  project: string
  title: string | null
  cost: number
  /** fraction of the block's cost (weighted, where the meter weighs families), 0..1 — the honest headline number */
  share: number
  /** share x measured delta, rounded for display; null when the delta is unknown */
  points: number | null
  requests: number
  /** distinct subagent transcripts that contributed */
  subagents: number
  start: number
  end: number
  tokens: number
  unpriced: boolean
}

export interface BlockSplit {
  /** the window the split covers: first to last api sample of the block */
  from: number
  to: number
  delta: number | null
  totalCost: number
  sessions: SessionSplit[]
  /** requests that landed in the block before the first sample: no delta covers them */
  costBeforeFirstSample: number
  /** requests since the last sample: the meter has not been read over them yet */
  costAfterLastSample: number
}

/**
 * divide the block's measured delta across sessions by list-price cost.
 *
 * `records` may span more than the window; only `from <= t < to` counts, exactly
 * as `jobs/survey.py` does, so tokens outside the observed span are never
 * charged to a meter movement nobody measured.
 */
export function splitBlock(
  records: RequestRecord[],
  sessions: Map<string, SessionMeta>,
  opts: {
    from: number
    to: number
    delta: number | null
    blockStart?: number
    /** the block's reset; requests after it belong to the next block, not this one's unread tail */
    blockEnd?: number
    /** what a request weighs in the division; list-price cost unless a meter counts families differently */
    weigh?: ((record: RequestRecord) => number) | undefined
  },
): BlockSplit {
  const { from, to, delta } = opts
  const blockStart = opts.blockStart ?? from
  const weigh = opts.weigh ?? ((record: RequestRecord) => record.cost)
  const byId = new Map<string, SessionSplit & { agentFiles: Set<string>; weight: number }>()
  let totalCost = 0
  let totalWeight = 0
  let costBeforeFirstSample = 0
  let costAfterLastSample = 0
  for (const record of records) {
    if (record.t >= blockStart && record.t < from) costBeforeFirstSample += record.cost
    if (record.t >= to && (opts.blockEnd === undefined || record.t < opts.blockEnd)) costAfterLastSample += record.cost
    if (record.t < from || record.t >= to) continue
    let row = byId.get(record.sessionId)
    if (!row) {
      const meta = sessions.get(record.sessionId)
      row = {
        sessionId: record.sessionId,
        project: meta?.project ?? record.project,
        title: meta?.title ?? null,
        cost: 0,
        share: 0,
        points: null,
        requests: 0,
        subagents: 0,
        start: record.t,
        end: record.t,
        tokens: 0,
        unpriced: false,
        agentFiles: new Set<string>(),
        weight: 0,
      }
      byId.set(record.sessionId, row)
    }
    row.cost += record.cost
    row.weight += weigh(record)
    row.requests += 1
    row.tokens += record.in + record.cw1h + record.cw5m + record.cr + record.out
    row.start = Math.min(row.start, record.t)
    row.end = Math.max(row.end, record.t)
    if (!record.priced) row.unpriced = true
    if (record.agent) row.agentFiles.add(record.file)
    totalCost += record.cost
    totalWeight += weigh(record)
  }
  const list: SessionSplit[] = [...byId.values()].map(({ agentFiles, weight, ...row }) => ({
    ...row,
    subagents: agentFiles.size,
    share: totalWeight > 0 ? weight / totalWeight : 0,
    points: delta === null || totalWeight <= 0 ? null : (weight / totalWeight) * delta,
  }))
  list.sort((a, b) => b.share - a.share)
  return { from, to, delta, totalCost, sessions: list, costBeforeFirstSample, costAfterLastSample }
}

/** shown under the weekly and Fable strips */
export const WEEK_CAVEAT =
  'Weekly movement split by list-price cost weighted per model, Fable movement by Fable cost alone. Approximate.'

/**
 * points of the 7-day meter per list dollar, from the weekly control in
 * `attribution-proof.md` (fitted 11 Sep 2026 over one weekly window, RMSE 0.86
 * points on a 28-point climb). a starting calibration to re-measure, not a
 * constant: a split only uses the ratio between families, and a boost or a plan
 * change can move that ratio silently.
 */
export const WEEKLY_POINTS_PER_DOLLAR = {
  measured: '2026-09-11',
  opus: 0.1352,
  fable: 0.0597,
  // the fit gave sonnet 0.0 and haiku 0.012 from a few dollars of either, which
  // is noise rather than a discount, so both borrow the opus rate until a week
  // with real sonnet or haiku use re-measures them. mythos and unknown models too.
  other: 0.1352,
} as const

export function weeklyWeight(family: Family): number {
  if (family === 'fable') return WEEKLY_POINTS_PER_DOLLAR.fable
  if (family === 'opus') return WEEKLY_POINTS_PER_DOLLAR.opus
  return WEEKLY_POINTS_PER_DOLLAR.other
}

const WEEK = 7 * 24 * 3600

export interface WeekWindow {
  from: number
  to: number
  since: 'lastLooked' | 'today'
}

/** one reading of a weekly meter */
export interface Reading {
  t: number
  pct: number
  resetsAt: number | null
}

export function weeklyReadings(samples: Sample[]): Reading[] {
  return samples.flatMap((s) => (s.weeklyPct === null ? [] : [{ t: s.t, pct: s.weeklyPct, resetsAt: s.weeklyResetsAt }]))
}

export function scopedReadings(samples: Sample[], model: string): Reading[] {
  return samples.flatMap((s) => {
    const meter = s.scoped.find((m) => m.model === model)
    return meter ? [{ t: s.t, pct: meter.pct, resetsAt: meter.resetsAt }] : []
  })
}

/**
 * the span the weekly split covers: since the last look, when that look is
 * inside the current weekly period, else since Prague midnight.
 *
 * a last look the sampler has read fewer than twice since (a reload a minute
 * later) has no movement to split, so it falls back to the day as well.
 */
export function weekWindow(
  now: number,
  lastLooked: number | null,
  weeklyResetsAt: number | null,
  readings: Reading[],
  midnight: number,
): WeekWindow {
  const inPeriod =
    lastLooked !== null && weeklyResetsAt !== null && lastLooked >= weeklyResetsAt - WEEK && lastLooked < now
  if (inPeriod) {
    const read = readings.filter((r) => r.t >= lastLooked && r.t <= now).length
    if (read >= 2 || lastLooked <= midnight) return { from: lastLooked, to: now, since: 'lastLooked' }
  }
  return { from: midnight, to: now, since: 'today' }
}

export interface WindowSplit extends BlockSplit {
  /** the meter at `from` and at `to` */
  startPct: number
  endPct: number
  /** the meter's weekly reset fell inside the window: nothing is split */
  crossedReset: boolean
}

/**
 * a block split over an arbitrary window of one weekly meter. `from` and `to`
 * snap to the first and last reading inside the window, so the delta is always
 * one the sampler measured.
 */
function splitWindow(
  records: RequestRecord[],
  sessions: Map<string, SessionMeta>,
  readings: Reading[],
  window: WeekWindow,
  weigh?: (record: RequestRecord) => number,
): WindowSplit | null {
  const inside = readings.filter((r) => r.t >= window.from && r.t <= window.to)
  const first = inside[0]
  const last = inside.at(-1)
  if (!first || !last) return null
  // resets_at jitters by a second between samples; a real reset moves it a week
  const movedReset =
    first.resetsAt !== null && last.resetsAt !== null && Math.abs(last.resetsAt - first.resetsAt) > 3600
  if (last.pct < first.pct || movedReset) {
    return {
      from: first.t,
      to: last.t,
      delta: null,
      totalCost: 0,
      sessions: [],
      costBeforeFirstSample: 0,
      costAfterLastSample: 0,
      startPct: first.pct,
      endPct: last.pct,
      crossedReset: true,
    }
  }
  const delta = last.t > first.t ? last.pct - first.pct : null
  // a meter that did not move still has honest shares, but no points to hand out
  const split = splitBlock(records, sessions, {
    from: first.t,
    to: last.t,
    delta: delta ? delta : null,
    blockStart: window.from,
    weigh,
  })
  return { ...split, delta, startPct: first.pct, endPct: last.pct, crossedReset: false }
}

/**
 * the Fable meter's movement over the window, divided by Fable list cost only.
 * a session with no Fable requests has no share, however big it is otherwise.
 */
export function splitFable(
  records: RequestRecord[],
  sessions: Map<string, SessionMeta>,
  readings: Reading[],
  window: WeekWindow,
): WindowSplit | null {
  return splitWindow(
    records.filter((record) => record.family === 'fable'),
    sessions,
    readings,
    window,
  )
}

/** the 7-day meter's movement over the window, divided by cost weighted per family */
export function splitWeekly(
  records: RequestRecord[],
  sessions: Map<string, SessionMeta>,
  readings: Reading[],
  window: WeekWindow,
): WindowSplit | null {
  return splitWindow(records, sessions, readings, window, (record) => record.cost * weeklyWeight(record.family))
}

export interface Projection {
  /** points per second over the observed span */
  pace: number
  /** where the meter lands at the reset if the pace holds */
  pctAtReset: number
  /** when it would reach 100, or null if it does not */
  hitsHundredAt: number | null
}

export function project(first: Sample, last: Sample, resetsAt: number): Projection {
  const span = last.t - first.t
  const pace = span > 0 ? (last.pct - first.pct) / span : 0
  const pctAtReset = last.pct + pace * Math.max(0, resetsAt - last.t)
  const hitsHundredAt =
    pace > 0 && pctAtReset >= 100 ? last.t + (100 - last.pct) / pace : null
  return { pace, pctAtReset: Math.min(100, pctAtReset), hitsHundredAt }
}

export interface DayDelta {
  day: string
  delta: number
  weekend: boolean
}

/**
 * how many points of a weekly meter each Prague day consumed.
 *
 * a day whose reading goes down crossed the weekly reset, so it is dropped
 * rather than clamped: half a week's burn is not a day's burn.
 */
export function dailyDeltas(samples: Sample[], pick: (s: Sample) => number | null): DayDelta[] {
  const byDay = new Map<string, { first: number; last: number; t: number }>()
  for (const sample of samples) {
    const value = pick(sample)
    if (value === null || Number.isNaN(value)) continue
    const key = dayKey(sample.t)
    const row = byDay.get(key)
    if (!row) byDay.set(key, { first: value, last: value, t: sample.t })
    else row.last = value
  }
  const out: DayDelta[] = []
  for (const [day, row] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const delta = row.last - row.first
    if (delta < 0) continue
    out.push({ day, delta, weekend: isWeekend(row.t) })
  }
  return out
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export interface WeeklyVerdict {
  /** points of this meter still unspent */
  remaining: number
  /** the median weekday burn this rule leans on, null when there is no history */
  typicalDay: number | null
  workdaysLeft: number
  phrase: string
}

/**
 * PROVISIONAL. the weekly verdict rule, to be judged on a real week.
 *
 * remaining points against this account's typical full working day, weekends
 * treated as free burn (they are not counted as days that need a day's worth of
 * points). the typical day is the median of the last few weekday deltas of the
 * same meter, so it re-calibrates itself rather than hard-coding a number.
 * every phrase this returns is one Mike already says out loud.
 */
export function weeklyVerdict(
  pct: number,
  resetsAt: number | null,
  now: number,
  weekdayDeltas: number[],
  label: string | null,
): WeeklyVerdict {
  const remaining = Math.max(0, 100 - pct)
  const typicalDay = median(weekdayDeltas.filter((d) => d > 0))
  const workdaysLeft = resetsAt ? workdaysBetween(now, resetsAt) : 0
  let phrase: string
  if (typicalDay === null) phrase = `${Math.round(remaining)} points left`
  // with a single workday left "on pace" and "a full day fits" are both true;
  // the second one is the sentence Mike actually says, so it wins
  else if (workdaysLeft > 1 && remaining >= typicalDay * workdaysLeft) phrase = 'on pace'
  else if (remaining >= typicalDay) phrase = label ? `a full ${label} day fits` : 'a full day fits'
  else if (remaining >= typicalDay * 0.4) phrase = 'one light day left'
  else phrase = 'over pace'
  return { remaining, typicalDay, workdaysLeft, phrase }
}
