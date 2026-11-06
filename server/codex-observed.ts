// every weekly Codex meter reading any source observed, grouped into windows.
//
// three kinds of source read the same account-wide meter: a meter log (this
// machine's reader in `codex-usage.jsonl`, or another machine's headless
// `codex-meter` copied into `codex-sources/<name>/codex-usage.jsonl`), and the
// `token_count` reading every rollout writes beside each call, from any machine
// whose rollouts are on disk here. the current week on the page and every
// window of `/api/history/codex` are cut from this one set, so the two agree.
// nothing is interpolated: an hour no source read stays a gap.
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexRollout } from './codex-sessions'
import { CODEX_WEEK_MINUTES, codexUsagePaths, readCodexHistory, type CodexUsageReading } from './codex-usage'

/** readings of one window agree on the reset to within this, as `splitCodexWeek` assumes */
export const RESET_JITTER_SECONDS = 120

export const WEEK_SECONDS = CODEX_WEEK_MINUTES * 60

/** a reading whose reset sits this close to its own time plus a week has not been pinned yet */
const FLOATING_SECONDS = 300

export interface Reading {
  t: number
  pct: number
  resetsAt: number
}

/** where other machines' Codex copies land: `codex-sources/<name>/`, one directory per machine */
export function codexSourcesDir(home = homedir()): string {
  return join(home, '.cache', 'tally', 'codex-sources')
}

/** the configured machines, by the directory name the sampler gave each */
export function codexSourceNames(home = homedir()): string[] {
  try {
    return readdirSync(codexSourcesDir(home), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** every meter log on disk: this machine's reader first, then each source's copied `codex-meter` log */
export function codexMeterLogs(home = homedir()): string[] {
  return [codexUsagePaths(home).history, ...codexSourceNames(home).map((name) => join(codexSourcesDir(home), name, 'codex-usage.jsonl'))]
}

/** the weekly readings in the given meter logs; a missing log reads as none */
export function meterReadings(paths: string[]): Reading[] {
  const out: Reading[] = []
  for (const path of paths) {
    for (const reading of readCodexHistory(path)) {
      if (reading.windowDurationMins !== CODEX_WEEK_MINUTES || reading.resetsAt <= 0) continue
      out.push({ t: reading.sampledAt, pct: reading.usedPercent, resetsAt: reading.resetsAt })
    }
  }
  return out
}

/** the meter logs' and the rollouts' readings together, oldest first, each distinct reading once */
export function observedReadings(meters: Reading[], rollouts: CodexRollout[]): Reading[] {
  const out: Reading[] = [...meters]
  for (const rollout of rollouts) {
    // a rollout routed to another provider never touched the Codex meter
    if (!rollout.openai) continue
    // an older Codex wrote readings with no reset time; they cannot be placed in a window
    for (const reading of rollout.readings) if (reading.resetsAt > 0) out.push(reading)
  }
  const seen = new Set<string>()
  return out
    .sort((a, b) => a.t - b.t || a.pct - b.pct || a.resetsAt - b.resetsAt)
    .filter((reading) => {
      const key = `${reading.t}:${reading.pct}:${reading.resetsAt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
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
export function groupWindows(readings: Reading[]): { resetsAt: number; readings: Reading[] }[] {
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

/**
 * the running window's readings as of `at`: the newest window, while its reset
 * is still ahead. null when every observed window is over.
 */
export function runningWindow(readings: Reading[], at: number): CodexUsageReading[] | null {
  const window = groupWindows(readings.filter((reading) => reading.t <= at)).at(-1)
  if (!window || window.resetsAt <= at) return null
  return window.readings.map((reading) => ({ sampledAt: reading.t, usedPercent: reading.pct, resetsAt: reading.resetsAt, windowDurationMins: CODEX_WEEK_MINUTES }))
}
