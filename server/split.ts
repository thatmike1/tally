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
import type { Sample } from './samples'

/** shown wherever a points figure appears */
export const CAVEAT =
  'Split by list-price cost across the block’s measured jump. Approximate to about a quarter of each figure.'

export interface SessionSplit {
  sessionId: string
  project: string
  title: string | null
  cost: number
  /** fraction of the block's cost, 0..1 — the honest headline number */
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
  opts: { from: number; to: number; delta: number | null; blockStart?: number },
): BlockSplit {
  const { from, to, delta } = opts
  const blockStart = opts.blockStart ?? from
  const byId = new Map<string, SessionSplit & { agentFiles: Set<string> }>()
  let totalCost = 0
  let costBeforeFirstSample = 0
  let costAfterLastSample = 0
  for (const record of records) {
    if (record.t >= blockStart && record.t < from) costBeforeFirstSample += record.cost
    if (record.t >= to) costAfterLastSample += record.cost
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
      }
      byId.set(record.sessionId, row)
    }
    row.cost += record.cost
    row.requests += 1
    row.tokens += record.in + record.cw1h + record.cw5m + record.cr + record.out
    row.start = Math.min(row.start, record.t)
    row.end = Math.max(row.end, record.t)
    if (!record.priced) row.unpriced = true
    if (record.agent) row.agentFiles.add(record.file)
    totalCost += record.cost
  }
  const list: SessionSplit[] = [...byId.values()].map(({ agentFiles, ...row }) => ({
    ...row,
    subagents: agentFiles.size,
    share: totalCost > 0 ? row.cost / totalCost : 0,
    points: delta === null || totalCost <= 0 ? null : (row.cost / totalCost) * delta,
  }))
  list.sort((a, b) => b.share - a.share)
  return { from, to, delta, totalCost, sessions: list, costBeforeFirstSample, costAfterLastSample }
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
