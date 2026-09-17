// `GET /api/history/codex`: every weekly window of the Codex meter with credits
// per percent and api list-price cost, mounted in `app.ts`.
//
// the current-week calibration in `codex-sessions.ts` run backwards. two reading
// sources are merged: Tally's own reader (`codex-usage.jsonl`, since 15 Sep 2026)
// and the `token_count` readings every rollout writes beside its calls, which
// reach back to the first Codex thread on disk. readings group into windows by
// the reset they report, with the same 120 s jitter tolerance `splitCodexWeek`
// uses, and a window's credits are the calls between its first and last reading,
// deduplicated by response id so a forked subagent's copied history counts once.
import { homedir } from 'node:os'
import { Hono } from 'hono'
import { codexSessionsRoot, scanRollouts, type CodexRollout } from './codex-sessions'
import { codexUsagePaths, readCodexHistory, CODEX_WEEK_MINUTES } from './codex-usage'
import type { CodexHistory, CodexWindow } from './history-types'
import { OPENAI_PRICE_TABLE, openAiCost } from './openai-prices'
import { startOfMonth } from './time'

/** the ChatGPT tier the dollars are compared against */
export const CODEX_PLAN_USD = 100

/** readings of one window agree on the reset to within this, as `splitCodexWeek` assumes */
const RESET_JITTER_SECONDS = 120

const WEEK_SECONDS = CODEX_WEEK_MINUTES * 60

export interface CodexHistoryOptions {
  home?: string
  now?: number
  /** injected by the tests; the real route scans `~/.codex/sessions` */
  rollouts?: CodexRollout[]
}

interface Reading {
  t: number
  pct: number
  resetsAt: number
}

/** every weekly reading Tally's reader and the rollouts know about, oldest first */
function allReadings(rollouts: CodexRollout[], history: { sampledAt: number; usedPercent: number; resetsAt: number; windowDurationMins: number }[]): Reading[] {
  const out: Reading[] = []
  for (const reading of history) {
    if (reading.windowDurationMins !== CODEX_WEEK_MINUTES || reading.resetsAt <= 0) continue
    out.push({ t: reading.sampledAt, pct: reading.usedPercent, resetsAt: reading.resetsAt })
  }
  for (const rollout of rollouts) {
    // a rollout routed to another provider never touched the Codex meter
    if (!rollout.openai) continue
    // an older Codex wrote readings with no reset time; they cannot be placed in a window
    for (const reading of rollout.readings) if (reading.resetsAt > 0) out.push(reading)
  }
  return out.sort((a, b) => a.t - b.t || a.pct - b.pct)
}

/** the reset the cluster's readings agree on: the value most of them reported */
function agreedReset(values: number[]): number {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
}

/** readings grouped into windows by the reset they report, oldest window first */
function groupWindows(readings: Reading[]): { resetsAt: number; readings: Reading[] }[] {
  const byReset = [...readings].sort((a, b) => a.resetsAt - b.resetsAt)
  const clusters: Reading[][] = []
  let anchor: number | null = null
  for (const reading of byReset) {
    if (anchor === null || reading.resetsAt - anchor > RESET_JITTER_SECONDS) {
      anchor = reading.resetsAt
      clusters.push([])
    }
    clusters.at(-1)!.push(reading)
  }
  return clusters
    .map((cluster) => ({
      resetsAt: agreedReset(cluster.map((reading) => reading.resetsAt)),
      readings: dropLaggards(cluster.sort((a, b) => a.t - b.t || a.pct - b.pct)),
    }))
    .filter((window) => window.readings.length > 0)
    .sort((a, b) => a.resetsAt - b.resetsAt)
}

/**
 * the meter only climbs inside a window, so a reading below the highest one seen
 * came from a rollout writing a stale value and would fake a negative delta.
 */
function dropLaggards(readings: Reading[]): Reading[] {
  const out: Reading[] = []
  let peak = -Infinity
  for (const reading of readings) {
    if (reading.pct < peak) continue
    peak = reading.pct
    out.push(reading)
  }
  return out
}

interface ModelTotals {
  calls: number
  input: number
  cached: number
  output: number
  credits: number
}

/** calls in `from..to`, deduplicated by response id exactly as `splitCodexWeek` does */
function callTotals(rollouts: CodexRollout[], from: number, to: number): Map<string, ModelTotals> {
  const seen = new Set<string>()
  const byModel = new Map<string, ModelTotals>()
  for (const rollout of rollouts) {
    if (!rollout.openai) continue
    for (const call of rollout.calls) {
      if (call.t < from || call.t > to || seen.has(call.responseId)) continue
      seen.add(call.responseId)
      let row = byModel.get(call.model)
      if (!row) {
        row = { calls: 0, input: 0, cached: 0, output: 0, credits: 0 }
        byModel.set(call.model, row)
      }
      row.calls += 1
      row.input += call.input
      row.cached += call.cached
      row.output += call.output
      row.credits += call.credits
    }
  }
  return byModel
}

/** rolls the per-model totals up into the shape a window publishes */
function priceModels(byModel: Map<string, ModelTotals>): {
  rows: CodexWindow['byModel']
  credits: number
  calls: number
  costUsd: number | null
  pricedCostUsd: number
  unknownModels: string[]
} {
  const rows: CodexWindow['byModel'] = {}
  const unknownModels: string[] = []
  let credits = 0
  let calls = 0
  let costUsd: number | null = 0
  let pricedCostUsd = 0
  for (const [model, row] of [...byModel.entries()].sort((a, b) => b[1].credits - a[1].credits)) {
    const cost = openAiCost(model, row.input, row.cached, row.output)
    if (cost === null) {
      unknownModels.push(model)
      // one unpriced model makes the window's total a guess, so there is no total
      costUsd = null
    } else {
      pricedCostUsd += cost
      if (costUsd !== null) costUsd += cost
    }
    rows[model] = { calls: row.calls, input: row.input, cached: row.cached, output: row.output, credits: row.credits, costUsd: cost }
    credits += row.credits
    calls += row.calls
  }
  return { rows, credits, calls, costUsd, pricedCostUsd, unknownModels: unknownModels.sort() }
}

/** one weekly window of the Codex meter, credits and dollars over its readings */
function buildWindow(rollouts: CodexRollout[], window: { resetsAt: number; readings: Reading[] }, now: number): CodexWindow {
  const first = window.readings[0]!
  const last = window.readings.at(-1)!
  const partial = window.resetsAt > now
  const { rows, credits, calls, costUsd, pricedCostUsd, unknownModels } = priceModels(callTotals(rollouts, first.t, last.t))
  const delta = window.readings.length > 1 ? last.pct - first.pct : null
  // Codex only started writing `token_usage_record` per call in September 2026,
  // so an older window has readings and no calls. that is "not measured", not a
  // free week, and it must not reach the charts as a zero.
  const measured = calls > 0
  return {
    resetsAt: window.resetsAt,
    start: window.resetsAt - WEEK_SECONDS,
    end: partial ? now : window.resetsAt,
    partial,
    from: first.t,
    to: last.t,
    startPct: first.pct,
    endPct: last.pct,
    delta,
    credits,
    creditsPerPercent: measured && delta !== null && delta > 0 ? credits / delta : null,
    costUsd: measured ? costUsd : null,
    pricedCostUsd,
    byModel: rows,
    unknownModels,
    calls,
  }
}

/** the whole `GET /api/history/codex` answer */
export async function buildCodexHistory(options: CodexHistoryOptions = {}): Promise<CodexHistory> {
  const now = options.now ?? Date.now() / 1000
  const home = options.home ?? homedir()
  const paths = codexUsagePaths(home)
  const root = codexSessionsRoot(home)
  // history reaches as far back as the rollouts do, so nothing is skipped by mtime
  const rollouts = options.rollouts ?? (await scanRollouts(0, root))
  const windows = groupWindows(allReadings(rollouts, readCodexHistory(paths.history))).map((window) =>
    buildWindow(rollouts, window, now),
  )

  const monthStart = startOfMonth(now)
  const month = priceModels(callTotals(rollouts, monthStart, now))

  return {
    now,
    windows,
    subValue: {
      monthCostUsd: month.costUsd,
      pricedMonthCostUsd: month.pricedCostUsd,
      monthStart,
      planUsd: CODEX_PLAN_USD,
      unknownModels: month.unknownModels,
    },
    prices: OPENAI_PRICE_TABLE,
    sources: { usage: paths.history, rollouts: root },
  }
}

/** the Codex history routes, mounted at `/api/history/codex` */
export function codexHistoryRoutes(options: CodexHistoryOptions = {}): Hono {
  const routes = new Hono()
  routes.get('/', async (c) => c.json(await buildCodexHistory(options)))
  return routes
}
