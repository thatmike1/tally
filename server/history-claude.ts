// `GET /api/history`: every 5-hour block and weekly window since the first
// meter sample, with list cost against measured meter movement. the routes are
// mounted in `app.ts` under `/api/history`.
//
// two rules from `attribution-proof.md` shape everything here:
//   - no mapping from tokens to 5-hour points exists (0.74 to 1.82 points per
//     list dollar across six blocks), so a dollars-per-percent figure is only
//     ever cost divided by a delta the sampler actually measured, and a block
//     that was saturated, read once, or read with a hole in it reports null.
//   - the weekly meters are well behaved by comparison, but they also count
//     Chats, which leave no transcript on this machine. so the weekly figure
//     divides cost into the part of the movement the transcripts can explain:
//     `cost / (delta * (1 - chats / 100))`, from `seven_day_breakdown`.
import { homedir } from 'node:os'
import { Hono } from 'hono'
import { defaultConfig, type PlanConfig } from './config'
import {
  MEASURED_MAX_GAP,
  type BlockSummary,
  type CacheRatio,
  type ClaudeHistory,
  type CostByFamily,
  type SubValue,
  type WeekSummary,
  type WindowUsage,
} from './history-types'
import type { Tokens } from './prices'
import { blocks as groupBlocks, limitsLogPath, monotonic, readSamples, type Sample } from './samples'
import { scopedReadings, WEEK, type Reading } from './split'
import { dayBounds, startOfMonth } from './time'
import { indexPath, type TranscriptIndex } from './transcript-index'
import { projectsRoot, scan, type RequestRecord } from './transcripts'
import { breakdownForWindow, chatsPercent, readBreakdowns, usageRawPath, WINDOW_JITTER } from './usage-raw'

export interface HistoryOptions {
  home?: string
  index?: TranscriptIndex | null
  now?: number
  /** the raw usage log, when a test points somewhere other than the home's */
  usageRaw?: string
  /** the plan the sub-value line is compared against; the default plan without a config file */
  plan?: PlanConfig
}

/**
 * the day the log's first api reading fell on, local time. the sampler's own
 * start is the only honest left edge: a baked-in date claims history on a
 * machine that has none. null with no samples at all.
 */
export function historySince(samples: Sample[]): number | null {
  const first = samples[0]
  return first ? dayBounds(first.t)[0] : null
}

export const CAVEAT =
  'Dollars per percent is shown for a 5-hour block only where the meter was measured across it (two readings, no saturation, no sampler gap). The weekly figure takes the Chats share off the movement first, because Chats leave no transcript here.'

function emptyTokens(): Tokens {
  return { in: 0, cw1h: 0, cw5m: 0, cr: 0, out: 0 }
}

/** cache read against uncached input, cache write against read; the one small line per window */
function cacheRatio(tokens: Tokens): CacheRatio {
  const input = tokens.in + tokens.cw1h + tokens.cw5m
  return {
    readVsInput: input > 0 ? tokens.cr / input : null,
    writeVsRead: tokens.cr > 0 ? (tokens.cw1h + tokens.cw5m) / tokens.cr : null,
  }
}

/**
 * tokens and list cost over `from <= t < to`, the same half-open window
 * `splitBlock` and `jobs/survey.py` use, so the history table and the block
 * split can never disagree about what a window cost.
 */
export function usageOver(records: RequestRecord[], from: number, to: number): WindowUsage {
  const tokens = emptyTokens()
  const costByFamily: CostByFamily = {}
  const sessions = new Set<string>()
  let cost = 0
  let requests = 0
  let unpriced = false
  for (const record of records) {
    if (record.t < from || record.t >= to) continue
    cost += record.cost
    costByFamily[record.family] = (costByFamily[record.family] ?? 0) + record.cost
    tokens.in += record.in
    tokens.cw1h += record.cw1h
    tokens.cw5m += record.cw5m
    tokens.cr += record.cr
    tokens.out += record.out
    requests += 1
    sessions.add(record.sessionId)
    if (!record.priced) unpriced = true
  }
  return { cost, costByFamily, tokens, requests, sessions: sessions.size, unpriced, cache: cacheRatio(tokens) }
}

/** a weekly meter only climbs inside its window; a lower reading is a stale one */
function climbing(readings: Reading[]): Reading[] {
  const kept: Reading[] = []
  let high = -1
  for (const reading of readings) {
    if (reading.pct >= high) {
      high = reading.pct
      kept.push(reading)
    }
  }
  return kept
}

interface WeekGroup {
  resetsAt: number
  samples: Sample[]
}

/**
 * samples grouped into weekly windows, oldest first. `resets_at` jitters by a
 * second between samples of the same window, so the key is rounded to the
 * minute and a reset within an hour of a group's is the same window.
 */
export function weekGroups(samples: Sample[]): WeekGroup[] {
  const groups: WeekGroup[] = []
  for (const sample of samples) {
    if (sample.weeklyResetsAt === null || sample.weeklyPct === null) continue
    const key = Math.round(sample.weeklyResetsAt / 60) * 60
    const found = groups.find((group) => Math.abs(group.resetsAt - key) <= WINDOW_JITTER)
    if (found) found.samples.push(sample)
    else groups.push({ resetsAt: key, samples: [sample] })
  }
  groups.sort((a, b) => a.resetsAt - b.resetsAt)
  return groups
}

function blockSummaries(samples: Sample[], records: RequestRecord[], now: number): BlockSummary[] {
  const out: BlockSummary[] = []
  for (const block of groupBlocks(samples)) {
    const kept = monotonic(block.samples)
    const first = kept[0]
    const last = kept.at(-1)
    if (!first || !last) continue
    let maxGap = 0
    for (let i = 1; i < kept.length; i++) maxGap = Math.max(maxGap, kept[i]!.t - kept[i - 1]!.t)
    // the meter is censored above 100, so movement inside a saturated block
    // is a lower bound and buys nothing
    const saturated = kept.some((s) => s.pct >= 100)
    const delta = kept.length > 1 && last.t > first.t ? last.pct - first.pct : null
    const measured = delta !== null && delta > 0 && !saturated && maxGap <= MEASURED_MAX_GAP
    const usage = usageOver(records, first.t, last.t)
    out.push({
      resetKey: block.resetKey,
      start: block.start,
      from: first.t,
      to: last.t,
      startPct: first.pct,
      endPct: last.pct,
      delta,
      saturated,
      maxGap,
      measured,
      usage,
      dollarsPerPercent: measured && delta ? usage.cost / delta : null,
      ended: block.resetKey <= now,
    })
  }
  return out
}

function weekSummaries(
  samples: Sample[],
  records: RequestRecord[],
  now: number,
  usageRaw: string,
): WeekSummary[] {
  const breakdowns = readBreakdowns(usageRaw)
  const out: WeekSummary[] = []
  for (const group of weekGroups(samples)) {
    const start = group.resetsAt - WEEK
    const partial = group.resetsAt > now
    const end = partial ? now : group.resetsAt
    const weekly = climbing(
      group.samples.map((s) => ({ t: s.t, pct: s.weeklyPct as number, resetsAt: s.weeklyResetsAt })),
    )
    const first = weekly[0]
    const last = weekly.at(-1)
    if (!first || !last) continue
    const delta = weekly.length > 1 && last.t > first.t ? last.pct - first.pct : null
    const usage = usageOver(records, first.t, last.t)

    const sample = breakdownForWindow(breakdowns, { windowStart: start, resetsAt: group.resetsAt, partial })
    const chats = chatsPercent(sample)
    // the transcripts explain everything but Chats, so that is the only part of
    // the movement list cost is divided into
    const explained = delta !== null && chats !== null ? delta * (1 - chats / 100) : null

    const model = group.samples.at(-1)?.scoped[0]?.model ?? null
    const fableRows = model ? climbing(scopedReadings(group.samples, model)) : []
    const fableFirst = fableRows[0] ?? null
    const fableLast = fableRows.at(-1) ?? null
    const fableDelta =
      fableFirst && fableLast && fableRows.length > 1 && fableLast.t > fableFirst.t
        ? fableLast.pct - fableFirst.pct
        : null
    const fableCost = usage.costByFamily.fable ?? 0

    out.push({
      resetsAt: group.resetsAt,
      start,
      end,
      partial,
      from: first.t,
      to: last.t,
      startPct: first.pct,
      endPct: last.pct,
      delta,
      breakdown: sample ? { at: sample.at, rows: sample.rows } : null,
      chatsPercent: chats,
      usage,
      dollarsPerPercent: explained !== null && explained > 0 ? usage.cost / explained : null,
      fable: {
        model,
        startPct: fableFirst?.pct ?? null,
        endPct: fableLast?.pct ?? null,
        delta: fableDelta,
        cost: fableCost,
        dollarsPerPercent: fableDelta !== null && fableDelta > 0 ? fableCost / fableDelta : null,
      },
    })
  }
  return out
}

function subValue(samples: Sample[], records: RequestRecord[], now: number, plan: PlanConfig): SubValue {
  const latest = samples.at(-1) ?? null
  const weekStart =
    latest?.weeklyResetsAt != null ? Math.round(latest.weeklyResetsAt / 60) * 60 - WEEK : startOfMonth(now)
  const monthStart = startOfMonth(now)
  return {
    weekCost: usageOver(records, weekStart, now).cost,
    weekStart,
    monthCost: usageOver(records, monthStart, now).cost,
    monthStart,
    planUsd: plan.usdPerMonth,
    planName: plan.name,
  }
}

/** everything `GET /api/history` answers with; the route is a thin wrapper on this */
export async function claudeHistory(options: HistoryOptions = {}): Promise<ClaudeHistory> {
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now() / 1000
  const index = options.index ?? null
  const plan = options.plan ?? defaultConfig().plan
  const samples = readSamples(limitsLogPath(home))
  const since = historySince(samples)
  // the month-to-date total reaches back past the first meter sample, so the
  // read starts at whichever of the two opens first
  const from = since === null ? startOfMonth(now) : Math.min(since, startOfMonth(now))
  const records =
    index && index.covers(from) ? index.query(from, now).records : (await scan(from, now, projectsRoot(home))).records
  const progress = index?.progress() ?? null
  return {
    since,
    now,
    blocks: blockSummaries(samples, records, now),
    weeks: weekSummaries(samples, records, now, options.usageRaw ?? usageRawPath(home)),
    subValue: subValue(samples, records, now, plan),
    indexing: progress ? progress.building || progress.cold : false,
    caveat: CAVEAT,
    sources: {
      limits: limitsLogPath(home),
      usageRaw: options.usageRaw ?? usageRawPath(home),
      index: index?.path ?? indexPath(home),
    },
  }
}

/** the Claude history routes, mounted at `/api/history` */
export function historyRoutes(options: HistoryOptions = {}): Hono {
  const routes = new Hono()
  routes.get('/', async (c) => c.json(await claudeHistory(options)))
  return routes
}
