// `GET /api/history/codex`: every weekly window of the Codex meter with credits
// per percent and api list-price cost, mounted in `app.ts`.
//
// the current-week calibration in `codex-sessions.ts` run backwards, over every
// reading `codex-observed.ts` knows: Tally's own reader (since 15 Sep 2026),
// other machines' `codex-meter` logs, and the `token_count` readings every
// rollout writes beside its calls, which reach back to the first Codex thread
// on disk. readings group into windows by the reset they report, with the same
// 120 s jitter tolerance `splitCodexWeek` uses, and a window's credits are the
// calls between its first and last reading,
// deduplicated by response id so a forked subagent's copied history counts once.
import { homedir } from 'node:os'
import { Hono } from 'hono'
import { codexMeterLogs, codexSourceNames, groupWindows, meterReadings, observedReadings, WEEK_SECONDS, type Reading } from './codex-observed'
import { codexSessionRoots, scanRollouts, type CodexRollout } from './codex-sessions'
import { codexBinaryPath, thinHistory, CODEX_WEEK_MINUTES } from './codex-usage'
import { defaultConfig, type PlanConfig } from './config'
import type { CodexHistory, CodexWindow } from './history-types'
import { OPENAI_PRICE_TABLE, openAiCost } from './openai-prices'
import { startOfMonth } from './time'
import { statePath } from './t3'

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
  const meters = codexMeterLogs(home)
  const root = codexSessionRoots(home)
  // history reaches as far back as the rollouts do, so nothing is skipped by mtime
  const rollouts = options.rollouts ?? (await scanRollouts(0, root, undefined, statePath(home)))
  const windows = groupWindows(observedReadings(meterReadings(meters), rollouts)).map((window, i, all) =>
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
    sources: { usage: meters[0]!, meters, rollouts: root, machines: codexSourceNames(home) },
  }
}

/** the Codex history routes, mounted at `/api/history/codex` */
export function codexHistoryRoutes(options: CodexHistoryOptions = {}): Hono {
  const routes = new Hono()
  routes.get('/', async (c) => c.json(await buildCodexHistory(options)))
  return routes
}
