// any window the timeline asks about: the meters' movement inside it, split
// across sessions the way the block split does (`GET /api/split`), and the
// lanes and meter samples to draw it (`GET /api/lanes`).
//
// a range can cross a 5-hour or a weekly reset, and a meter reading after a
// reset says nothing about one before it, so a range is cut into pieces, one per
// block or weekly window it touches. each piece's measured movement is divided
// over the requests inside that piece's own sampled span, by list-price cost as
// `attribution-proof.md` settled, and the range's movement is the sum of the
// pieces, never last reading minus first.
import { homedir } from 'node:os'
import type { IndexProgress, Lane } from './history-types'
import { LANE_GAP } from './history-types'
import { buildLanes } from './lanes'
import { blocks as groupBlocks, limitsLogPath, monotonic, readLog, type Sample } from './samples'
import {
  scopedReadings,
  splitBlock,
  WEEK,
  WEEK_CAVEAT,
  weeklyReadings,
  weeklyWeight,
  type Reading,
  type SessionSplit,
} from './split'
import { sessionRow, type RowContext, type SessionRow } from './state'
import { claudeThreadTitles, otherThreads, statePath } from './t3'
import type { TranscriptIndex } from './transcript-index'
import { projectsRoot, scan, type RequestRecord, type SessionMeta } from './transcripts'
import type { SplitUsage } from './usage'
import { WINDOW_JITTER } from './usage-raw'

/** the longest window either endpoint answers: a quarter, so the since-8-Sep zoom fits until December */
export const MAX_RANGE = 92 * 24 * 3600

/** a window the lanes endpoint coarsens to about this many steps across */
export const LANE_STEPS = 2000

/** shown beside a range split's points */
export const RANGE_CAVEAT =
  'Each 5-hour block and each week the range touches is split on its own, by list-price cost over the span its readings cover, and the range adds the pieces up. Approximate to about a quarter of each figure.'

/** one block or weekly window's readings inside the range */
export interface MeterPiece {
  /** the reset that closes this block or week (`resetKey` for a block); null when the readings carried none */
  resetsAt: number | null
  /** first and last reading of this window inside the range: the span `delta` covers */
  from: number
  to: number
  startPct: number
  endPct: number
  /** endPct - startPct; null with a single reading, which measures nothing */
  delta: number | null
  /** the meter read 100 inside the piece, so its movement is a floor */
  saturated: boolean
}

/**
 * one meter's movement over a range, split across the sessions that ran in it.
 *
 * the rows and `usage` cover every request in `from..to`. a row's `share` is
 * its part of the range's list cost (weighted per model family on the weekly
 * meter, as the week split weighs it); its `points` add up each piece's delta
 * divided over the requests inside that piece's span, so a range that is
 * exactly one block's sampled span gives the block split's figures.
 */
export interface RangeMeterSplit {
  /** the range asked for; the rows and usage cover `from <= t < to` */
  from: number
  to: number
  /** the pieces' measured deltas added up; null when no piece measured anything */
  delta: number | null
  /** oldest first */
  pieces: MeterPiece[]
  totalCost: number
  /** ranked by share; `points` null exactly when `delta` is */
  sessions: SessionRow[]
  usage: SplitUsage
  /** list cost of requests in the range outside every piece's measured span: they get no points */
  costUnmeasured: number
  /** measured movement inside a piece with no local request to divide it over (Chats, another machine); null when `delta` is */
  pointsUnattributed: number | null
}

/** `GET /api/split?from=&to=` */
export interface RangeSplit {
  from: number
  to: number
  now: number
  caveat: string
  weekCaveat: string
  /** the index is still building or rereading; see `IndexProgress` */
  index: IndexProgress
  fiveHour: RangeMeterSplit
  weekly: RangeMeterSplit
  /** the per-model weekly meter (Fable), split over Fable requests only; null when the account reports none */
  fable: (RangeMeterSplit & { model: string }) | null
}

/** one point of the meter line, the shape of `State['day']['meter']` */
export interface MeterPoint {
  t: number
  pct: number
  resetKey: number
  weeklyPct: number | null
  /** the per-model weekly meter (Fable), when the sample carried it */
  scopedPct: number | null
}

/** `GET /api/lanes?from=&to=` */
export interface RangeLanes {
  from: number
  to: number
  now: number
  /**
   * seconds: requests closer than this merge into one lane segment, and the
   * meter keeps at most one sample per block per step of this size. `LANE_GAP`
   * (300) up to a week, then the window over `LANE_STEPS`, so a long zoom is
   * never finer than the page can draw
   */
  resolution: number
  /** the shape of `State['day']['lanes']` */
  lanes: Lane[]
  /** oldest first; every block's first sample is kept, so each sawtooth starts where it did */
  meter: MeterPoint[]
  /** the model the `scopedPct` column is for; null when no sample carried one */
  scopedModel: string | null
  index: IndexProgress
}

export interface RangeOptions {
  home?: string
  index?: TranscriptIndex | null
  now?: number
}

/** a range that is not two unix-second numbers in order, or is longer than `MAX_RANGE` */
export class BadRange extends Error {}

/** reads `from` and `to` off a query; throws `BadRange` with the message the route answers 400 with */
export function parseRange(fromRaw: string | undefined, toRaw: string | undefined): { from: number; to: number } {
  const from = Number(fromRaw)
  const to = Number(toRaw)
  if (fromRaw === undefined || toRaw === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
    throw new BadRange('from and to must be unix seconds')
  }
  if (to <= from) throw new BadRange('to must be after from')
  if (to - from > MAX_RANGE) throw new BadRange(`a range is at most ${MAX_RANGE / 86400} days`)
  return { from, to }
}

function progressOf(index: TranscriptIndex | null): IndexProgress {
  return index?.progress() ?? { building: false, done: 0, total: 0, builtAt: null, cold: true, failed: 0, stale: 0 }
}

async function recordsOver(
  from: number,
  to: number,
  home: string,
  index: TranscriptIndex | null,
): Promise<{ records: RequestRecord[]; sessions: Map<string, SessionMeta> }> {
  if (index && index.covers(from)) return index.query(from, to)
  // the index has not reached this far back yet: read the tree, as the state does
  return await scan(from, to, projectsRoot(home))
}

/** readings of one meter inside `from..to`, as a piece; null when none fall inside */
function pieceOf(readings: Reading[], from: number, to: number): MeterPiece | null {
  const inside = readings.filter((r) => r.t >= from && r.t <= to)
  const first = inside[0]
  const last = inside.at(-1)
  if (!first || !last) return null
  return {
    resetsAt: last.resetsAt,
    from: first.t,
    to: last.t,
    startPct: first.pct,
    endPct: last.pct,
    delta: inside.length > 1 && last.t > first.t ? last.pct - first.pct : null,
    saturated: inside.some((r) => r.pct >= 100),
  }
}

/** the five-hour meter cut per block: each block's climbing readings inside the range */
export function fiveHourPieces(samples: Sample[], from: number, to: number): MeterPiece[] {
  const pieces: MeterPiece[] = []
  for (const block of groupBlocks(samples)) {
    const readings = monotonic(block.samples).map((s) => ({ t: s.t, pct: s.pct, resetsAt: block.resetKey }))
    const piece = pieceOf(readings, from, to)
    if (piece) pieces.push(piece)
  }
  return pieces
}

/**
 * a weekly meter cut per weekly window. inside a window it only climbs, so a
 * lower reading is dropped as stale; a window that opens inside the range reads
 * 0 at its opening, as the whole-week split assumes, so the movement between
 * the reset and the sampler's first reading after it is not lost.
 */
export function weeklyPieces(readings: Reading[], from: number, to: number): MeterPiece[] {
  const groups: { resetsAt: number | null; readings: Reading[] }[] = []
  for (const reading of readings) {
    const found = groups.find((group) =>
      group.resetsAt === null || reading.resetsAt === null
        ? group.resetsAt === reading.resetsAt
        : Math.abs(group.resetsAt - reading.resetsAt) <= WINDOW_JITTER,
    )
    if (found) found.readings.push(reading)
    else groups.push({ resetsAt: reading.resetsAt, readings: [reading] })
  }
  const pieces: MeterPiece[] = []
  for (const group of groups) {
    let rows = [...group.readings].sort((a, b) => a.t - b.t)
    if (group.resetsAt !== null) {
      const opens = group.resetsAt - WEEK
      if (rows[0]!.t > opens) rows = [{ t: opens, pct: 0, resetsAt: group.resetsAt }, ...rows]
    }
    let high = -1
    const climbing = rows.filter((row) => {
      if (row.pct < high) return false
      high = row.pct
      return true
    })
    const piece = pieceOf(climbing, from, to)
    if (piece) pieces.push(piece)
  }
  pieces.sort((a, b) => a.from - b.from)
  return pieces
}

/** a range split before its rows are ranked and coloured */
export type RawRangeSplit = Omit<RangeMeterSplit, 'sessions'> & { sessions: SessionSplit[] }

/**
 * divide each piece's measured delta over the requests inside its span, and
 * share the range's cost across the sessions that ran in it.
 *
 * @param weigh what a request weighs in the division; list-price cost unless the meter weighs families differently
 */
export function splitRange(
  records: RequestRecord[],
  sessions: Map<string, SessionMeta>,
  pieces: MeterPiece[],
  from: number,
  to: number,
  weigh: (record: RequestRecord) => number = (record) => record.cost,
): RawRangeSplit {
  const inRange = records.filter((record) => record.t >= from && record.t < to)
  const base = splitBlock(inRange, sessions, { from, to, delta: null, weigh })
  const points = new Map<string, number>()
  let delta: number | null = null
  let pointsUnattributed = 0
  let costMeasured = 0
  for (const piece of pieces) {
    const inside = inRange.filter((record) => record.t >= piece.from && record.t < piece.to)
    for (const record of inside) costMeasured += record.cost
    if (piece.delta === null) continue
    delta = (delta ?? 0) + piece.delta
    const weights = new Map<string, number>()
    let total = 0
    for (const record of inside) {
      const weight = weigh(record)
      weights.set(record.sessionId, (weights.get(record.sessionId) ?? 0) + weight)
      total += weight
    }
    if (total <= 0) {
      pointsUnattributed += piece.delta
      continue
    }
    for (const [sessionId, weight] of weights) {
      points.set(sessionId, (points.get(sessionId) ?? 0) + (weight / total) * piece.delta)
    }
  }
  return {
    from,
    to,
    delta,
    pieces,
    totalCost: base.totalCost,
    sessions: base.sessions.map((row) => ({
      ...row,
      points: delta === null ? null : (points.get(row.sessionId) ?? 0),
    })),
    usage: base.usage,
    costUnmeasured: Math.max(0, base.totalCost - costMeasured),
    pointsUnattributed: delta === null ? null : pointsUnattributed,
  }
}

/** everything `GET /api/split` answers with; the route is a thin wrapper on this */
export async function rangeSplit(from: number, to: number, options: RangeOptions = {}): Promise<RangeSplit> {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now() / 1000
  const index = options.index ?? null
  const samples = readLog(limitsLogPath(home)).samples
  const { records, sessions } = await recordsOver(from, to, home, index)

  const fiveHour = splitRange(records, sessions, fiveHourPieces(samples, from, to), from, to)
  const weekly = splitRange(records, sessions, weeklyPieces(weeklyReadings(samples), from, to), from, to, (record) =>
    record.cost * weeklyWeight(record.family),
  )
  // the per-model meter the account reported last by the end of the range
  const fableName = samples.filter((s) => s.t <= to && s.scoped.length).at(-1)?.scoped[0]?.model ?? null
  const fable = fableName
    ? splitRange(
        records.filter((record) => record.family === 'fable'),
        sessions,
        weeklyPieces(scopedReadings(samples, fableName), from, to),
        from,
        to,
      )
    : null

  const context: RowContext = { now, sessions, shortTitles: claudeThreadTitles(statePath(home)), fable }
  // the week sections rank by Fable share, then weekly share, as the state's week split does
  const weekRank = new Map<string, number>()
  for (const row of [...(fable?.sessions ?? []), ...weekly.sessions]) {
    if (!weekRank.has(row.sessionId)) weekRank.set(row.sessionId, weekRank.size)
  }
  const ranked = (raw: RawRangeSplit, rank: (row: SessionSplit, i: number) => number): RangeMeterSplit => ({
    ...raw,
    sessions: raw.sessions.map((row, i) => sessionRow(row, rank(row, i), context)),
  })
  return {
    from,
    to,
    now,
    caveat: RANGE_CAVEAT,
    weekCaveat: WEEK_CAVEAT,
    index: progressOf(index),
    fiveHour: ranked(fiveHour, (_, i) => i),
    weekly: ranked(weekly, (row) => weekRank.get(row.sessionId)!),
    fable: fable && fableName ? { ...ranked(fable, (row) => weekRank.get(row.sessionId)!), model: fableName } : null,
  }
}

/** seconds per lane segment gap and per meter step for a window this long */
export function resolutionFor(span: number): number {
  return Math.max(LANE_GAP, Math.ceil(span / LANE_STEPS))
}

/**
 * the meter samples inside `from..to`, at most one per block per `resolution`
 * step: the last of each step, which inside a block is its highest reading,
 * plus every block's first sample so each sawtooth starts where it did.
 */
export function meterPoints(samples: Sample[], from: number, to: number, resolution: number, scopedModel: string | null): MeterPoint[] {
  const kept = new Map<string, Sample>()
  const firsts = new Set<number>()
  for (const sample of samples) {
    if (sample.t < from || sample.t >= to) continue
    if (!firsts.has(sample.resetKey)) {
      firsts.add(sample.resetKey)
      kept.set(`${sample.resetKey}:first`, sample)
      continue
    }
    kept.set(`${sample.resetKey}:${Math.floor(sample.t / resolution)}`, sample)
  }
  return [...kept.values()]
    .sort((a, b) => a.t - b.t)
    .map((s) => ({
      t: s.t,
      pct: s.pct,
      resetKey: s.resetKey,
      weeklyPct: s.weeklyPct,
      scopedPct: scopedModel ? (s.scoped.find((m) => m.model === scopedModel)?.pct ?? null) : null,
    }))
}

/** everything `GET /api/lanes` answers with */
export async function rangeLanes(from: number, to: number, options: RangeOptions = {}): Promise<RangeLanes> {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now() / 1000
  const index = options.index ?? null
  const resolution = resolutionFor(to - from)
  const samples = readLog(limitsLogPath(home)).samples
  const { records, sessions } = await recordsOver(from, to, home, index)
  const threads = otherThreads(from, to, statePath(home), resolution)
  const lanes = buildLanes({
    records,
    sessions,
    threads,
    from,
    to,
    now,
    gap: resolution,
    shortTitles: claudeThreadTitles(statePath(home)),
  })
  const scopedModel = samples.filter((s) => s.t < to && s.scoped.length).at(-1)?.scoped[0]?.model ?? null
  return {
    from,
    to,
    now,
    resolution,
    lanes,
    meter: meterPoints(samples, from, to, resolution, scopedModel),
    scopedModel,
    index: progressOf(index),
  }
}
