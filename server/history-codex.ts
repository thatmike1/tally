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
import { codexSessionRoots, scanRollouts, type CodexRollout } from './codex-sessions'
import { codexBinaryPath, codexUsagePaths, readCodexHistory, thinHistory, CODEX_WEEK_MINUTES } from './codex-usage'
import { defaultConfig, type PlanConfig } from './config'
import type { CodexHistory, CodexWindow } from './history-types'
import { OPENAI_PRICE_TABLE, openAiCost } from './openai-prices'
import { startOfMonth } from './time'
import { statePath } from './t3'

/** readings of one window agree on the reset to within this, as `splitCodexWeek` assumes */
const RESET_JITTER_SECONDS = 120

const WEEK_SECONDS = CODEX_WEEK_MINUTES * 60

/** a reading whose reset sits this close to its own time plus a week has not been pinned yet */
const FLOATING_SECONDS = 300

export interface CodexHistoryOptions {
  home?: string
  now?: number
  /** injected by the tests; the real route scans `~/.codex/sessions` and the upstream copy */
  rollouts?: CodexRollout[]
  /** the ChatGPT tier the dollars are compared against */
  plan?: PlanConfig
  /** whether this machine has Codex at all; found from the binary when not given */
  installed?: boolean
}

export interface Reading {
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

/**
 * after a reset the meter sits at 0% with its reset floating at now plus a week
 * until the first call pins it, so each idle reading reports a reset of its own.
 * they belong to the window that call opens, or, with no call yet, to the
 * newest of them.
 */
export function pinFloating(readings: Reading[]): Reading[] {
  const floating = (reading: Reading) => reading.pct === 0 && Math.abs(reading.resetsAt - reading.t - WEEK_SECONDS) <= FLOATING_SECONDS
  const out = readings.map((reading) => ({ ...reading }))
  let pinned: number | null = null
  for (let i = out.length - 1; i >= 0; i--) {
    const reading = out[i]!
    if (!floating(reading)) {
      pinned = reading.resetsAt
      continue
    }
    // the next pinned window can only open at or after this idle reading's reset
    if (pinned !== null && pinned >= reading.resetsAt - RESET_JITTER_SECONDS) reading.resetsAt = pinned
    else pinned = reading.resetsAt
  }
  return out
}

/** readings grouped into windows by the reset they report, oldest window first */
function groupWindows(readings: Reading[]): { resetsAt: number; readings: Reading[] }[] {
  const byReset = [...pinFloating(readings)].sort((a, b) => a.resetsAt - b.resetsAt)
  const clusters: Reading[][] = []
  let anchor: number | null = null
  for (const reading of byReset) {
    if (anchor === null || reading.resetsAt - anchor > RESET_JITTER_SECONDS) {
      anchor = reading.resetsAt
      clusters.push([])
    }
    clusters.at(-1)!.push(reading)
  }
  // a cluster is anchored on its lowest reset, so readings drifting a few seconds
  // at a time can cut one window in two; rejoin clusters that agree on a reset
  const merged: Reading[][] = []
  for (const cluster of clusters) {
    const previous = merged.at(-1)
    const agreed = (readings: Reading[]) => agreedReset(readings.map((reading) => reading.resetsAt))
    if (previous && Math.abs(agreed(cluster) - agreed(previous)) <= RESET_JITTER_SECONDS) previous.push(...cluster)
    else merged.push(cluster)
  }
  return merged
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
  costUsd: number | null
  unknownSpeedCalls: number
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
        row = { calls: 0, input: 0, cached: 0, output: 0, credits: 0, costUsd: 0, unknownSpeedCalls: 0 }
        byModel.set(call.model, row)
      }
      row.calls += 1
      row.input += call.input
      row.cached += call.cached
      row.output += call.output
      row.credits += call.credits
      const cost = openAiCost(call.model, call.input, call.cached, call.output, call.speed)
      if (row.costUsd === null || cost === null) row.costUsd = null
      else row.costUsd += cost
      if (call.speed === null) row.unknownSpeedCalls++
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
    const cost = row.costUsd
    if (cost === null) {
      unknownModels.push(model)
      // one unpriced model makes the window's total a guess, so there is no total
      costUsd = null
    } else {
      pricedCostUsd += cost
      if (costUsd !== null) costUsd += cost
    }
    rows[model] = { calls: row.calls, input: row.input, cached: row.cached, output: row.output, credits: row.credits, costUsd: cost, unknownSpeedCalls: row.unknownSpeedCalls }
    credits += row.credits
    calls += row.calls
  }
  return { rows, credits, calls, costUsd, pricedCostUsd, unknownModels: unknownModels.sort() }
}

/** one weekly window of the Codex meter, credits and dollars over its readings */
function buildWindow(
  rollouts: CodexRollout[],
  window: { resetsAt: number; readings: Reading[] },
  now: number,
  next: { resetsAt: number; readings: Reading[] } | undefined,
): CodexWindow {
  const first = window.readings[0]!
  const last = window.readings.at(-1)!
  // an early reset cuts a window short: a later window has started, so this one is
  // over by the time the next was first seen, or by the call that pinned its reset
  const cutAt = next ? Math.min(window.resetsAt, next.readings[0]!.t, next.resetsAt - WEEK_SECONDS) : window.resetsAt
  const partial = cutAt > now
  const { rows, credits, calls, costUsd, pricedCostUsd, unknownModels } = priceModels(callTotals(rollouts, first.t, last.t))
  const delta = window.readings.length > 1 ? last.pct - first.pct : null
  // Codex only started writing `token_usage_record` per call in September 2026,
  // so an older window has readings and no calls. that is "not measured", not a
  // free week, and it must not reach the charts as a zero.
  const measured = calls > 0
  return {
    resetsAt: window.resetsAt,
    start: window.resetsAt - WEEK_SECONDS,
    end: partial ? now : cutAt,
    partial,
    resetEarly: cutAt < window.resetsAt,
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
    points: thinHistory(window.readings.map((reading) => ({ sampledAt: reading.t, usedPercent: reading.pct, resetsAt: reading.resetsAt, windowDurationMins: CODEX_WEEK_MINUTES }))),
  }
}

/** the whole `GET /api/history/codex` answer */
export async function buildCodexHistory(options: CodexHistoryOptions = {}): Promise<CodexHistory> {
  const now = options.now ?? Date.now() / 1000
  const home = options.home ?? homedir()
  const plan = options.plan ?? defaultConfig().codexPlan
  const installed = options.installed ?? codexBinaryPath(home) !== null
  const paths = codexUsagePaths(home)
  const root = codexSessionRoots(home)
  // history reaches as far back as the rollouts do, so nothing is skipped by mtime
  const rollouts = options.rollouts ?? (await scanRollouts(0, root, undefined, statePath(home)))
  const windows = groupWindows(allReadings(rollouts, readCodexHistory(paths.history))).map((window, i, all) =>
    buildWindow(rollouts, window, now, all[i + 1]),
  )

  const monthStart = startOfMonth(now)
  const month = priceModels(callTotals(rollouts, monthStart, now))

  return {
    now,
    installed,
    windows,
    subValue: {
      monthCostUsd: month.costUsd,
      pricedMonthCostUsd: month.pricedCostUsd,
      monthStart,
      planUsd: plan.usdPerMonth,
      planName: plan.name,
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
