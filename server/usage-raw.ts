// the whole `GET /api/oauth/usage` payload, as the sampler has kept it since
// 14 Sep 2026 (`~/.cache/cc-browse-tray/usage-raw.jsonl`, one row per sample).
//
// tally reads exactly one thing out of it: `seven_day_breakdown`, the endpoint's
// own split of the weekly meter by surface (`claude_code`, `chat`, `cowork`,
// `other`, percentages of the week that sum to 100). Chats leave no transcript
// on this machine, so the weekly dollars-per-percent figure has to take the
// Chats share off the meter movement before dividing cost into it.
//
// the file is append-only and written by a timer, so a half-written last line is
// normal: a row that does not parse, or that carries no breakdown, is skipped
// rather than treated as an empty breakdown.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function usageRawPath(home = homedir()): string {
  return join(home, '.cache', 'cc-browse-tray', 'usage-raw.jsonl')
}

/** one `seven_day_breakdown` as one sample carried it */
export interface BreakdownSample {
  /** when the row was sampled, unix seconds */
  at: number
  /** the endpoint's own timestamp on the breakdown, unix seconds; null when it carried none */
  asOf: number | null
  /** the weekly window it describes: `window_started_at`, unix seconds; null when absent */
  windowStart: number | null
  /** percent of the week per surface key, as given */
  rows: Record<string, number>
}

/** `resets_at` and `window_started_at` jitter by a second between samples, as `split.ts` notes */
export const WINDOW_JITTER = 3600

function isoSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms / 1000 : null
}

/**
 * every breakdown in the log, oldest first. malformed lines, rows with no
 * breakdown and rows with no usable `rows` array are skipped.
 */
export function readBreakdowns(path = usageRawPath()): BreakdownSample[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: BreakdownSample[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, any>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const at = Number(row?.t)
    if (!Number.isFinite(at)) continue
    const breakdown = row?.payload?.seven_day_breakdown
    if (!breakdown || !Array.isArray(breakdown.rows)) continue
    const rows: Record<string, number> = {}
    for (const entry of breakdown.rows) {
      const key = entry?.key
      const percent = Number(entry?.percent)
      if (typeof key !== 'string' || !Number.isFinite(percent)) continue
      rows[key] = percent
    }
    if (!Object.keys(rows).length) continue
    out.push({
      at,
      asOf: isoSeconds(breakdown.as_of),
      windowStart: isoSeconds(breakdown.window_started_at),
      rows,
    })
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

export interface WindowQuery {
  /** the weekly window's opening, unix seconds */
  windowStart: number
  /** the reset that closes it */
  resetsAt: number
  /** the window has not reset yet, so the latest sample is the best there is */
  partial: boolean
}

/**
 * the breakdown that describes one weekly window: the last one sampled before
 * the window's reset (the latest one, while the window is still open) whose
 * `window_started_at` is this window's. a breakdown from a neighbouring window
 * is never borrowed, so a week the sampler did not cover reports null.
 */
export function breakdownForWindow(samples: BreakdownSample[], window: WindowQuery): BreakdownSample | null {
  let best: BreakdownSample | null = null
  for (const sample of samples) {
    if (sample.windowStart === null) continue
    if (Math.abs(sample.windowStart - window.windowStart) > WINDOW_JITTER) continue
    if (!window.partial && sample.at > window.resetsAt) continue
    if (!best || sample.at > best.at) best = sample
  }
  return best
}

/** the Chats share of the week, the part of the meter no transcript explains; null without a breakdown */
export function chatsPercent(sample: BreakdownSample | null): number | null {
  if (!sample) return null
  const value = sample.rows.chat
  return Number.isFinite(value) ? (value as number) : null
}
