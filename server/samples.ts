// the account meters, read out of the sampler's log.
//
// data-quality rules are the attribution proof's, not new here:
//   - only `src: "api"` rows. a statusline payload is whatever that one terminal
//     last heard, so an idle tab redrawn later republishes a stale number; 26%
//     of the statusline rows with an api row within two minutes disagreed by two
//     points or more.
//   - `resets_at` jitters by a second between samples of the same block, so the
//     block key is `round(resets_at / 60) * 60`.
//   - inside a block the meter only climbs; a lower reading is stale.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FIVE_HOURS = 5 * 3600

export interface ScopedMeter {
  model: string
  pct: number
  resetsAt: number | null
}

export interface Sample {
  /** unix seconds */
  t: number
  pct: number
  resetsAt: number
  /** `resets_at` rounded to the minute; the block identity */
  resetKey: number
  weeklyPct: number | null
  weeklyResetsAt: number | null
  scoped: ScopedMeter[]
  /** paid overflow, when the endpoint reported any */
  extra: { used: number | null; limit: number | null; currency: string | null } | null
  /**
   * every top-level field of the sample row that tally does not model. the
   * September boost ("weekly limit 50% higher through the 13th") has no field in
   * the payload today; if the endpoint grows a boost or scope key, the sampler
   * will carry it here and the page shows it as a note. nothing computes on it.
   */
  unknown: Record<string, unknown>
}

export interface Block {
  resetKey: number
  /** block start, five hours before the reset */
  start: number
  samples: Sample[]
}

export function limitsLogPath(home = homedir()): string {
  return join(home, '.cache', 'cc-browse-tray', 'limits.jsonl')
}

const KNOWN_KEYS = new Set(['t', 'src', 'limits', 'scoped', 'extra'])

/** api-sourced meter readings, oldest first */
export function readSamples(path = limitsLogPath()): Sample[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: Sample[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, any>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.src !== 'api') continue
    const fiveHour = row.limits?.five_hour
    if (!fiveHour?.resets_at) continue
    const sevenDay = row.limits?.seven_day ?? null
    const unknown: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (!KNOWN_KEYS.has(key)) unknown[key] = value
    }
    out.push({
      t: Number(row.t),
      pct: Number(fiveHour.used_percentage),
      resetsAt: Number(fiveHour.resets_at),
      resetKey: Math.round(Number(fiveHour.resets_at) / 60) * 60,
      weeklyPct: sevenDay?.used_percentage ?? null,
      weeklyResetsAt: sevenDay?.resets_at ?? null,
      scoped: (row.scoped ?? []).map((s: any) => ({
        model: String(s.model ?? '?'),
        pct: Number(s.percent),
        resetsAt: s.resets_at ?? null,
      })),
      extra: row.extra
        ? {
            used: row.extra.used ?? null,
            limit: row.extra.limit ?? null,
            currency: row.extra.currency ?? null,
          }
        : null,
      unknown,
    })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** samples grouped into five-hour blocks, oldest block first */
export function blocks(samples: Sample[]): Block[] {
  const by = new Map<number, Sample[]>()
  for (const sample of samples) {
    const list = by.get(sample.resetKey)
    if (list) list.push(sample)
    else by.set(sample.resetKey, [sample])
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([resetKey, rows]) => ({ resetKey, start: resetKey - FIVE_HOURS, samples: rows }))
}

/** within a block the meter only climbs; a lower reading is stale */
export function monotonic(rows: Sample[]): Sample[] {
  const kept: Sample[] = []
  let high = -1
  for (const row of rows) {
    if (row.pct >= high) {
      high = row.pct
      kept.push(row)
    }
  }
  return kept
}

export interface CurrentBlock {
  block: Block
  /** the monotonic-filtered samples */
  samples: Sample[]
  first: Sample
  last: Sample
  /** measured meter movement across the observed span, in points */
  delta: number
  /** the block's reset is already in the past: the sampler is behind */
  expired: boolean
  /** seconds since the newest api sample */
  sampleAge: number
  /** the meter hit 100 inside this block, so later movement is censored */
  saturated: boolean
  /** the largest gap between consecutive samples, seconds */
  maxGap: number
}

/** the newest block in the log, with everything the page derives from it */
export function currentBlock(all: Block[], now: number): CurrentBlock | null {
  const block = all.at(-1)
  if (!block) return null
  const samples = monotonic(block.samples)
  const first = samples[0]!
  const last = samples.at(-1)!
  let maxGap = 0
  for (let i = 1; i < samples.length; i++) maxGap = Math.max(maxGap, samples[i]!.t - samples[i - 1]!.t)
  return {
    block,
    samples,
    first,
    last,
    delta: last.pct - first.pct,
    expired: block.resetKey <= now,
    sampleAge: now - last.t,
    saturated: last.pct >= 100,
    maxGap,
  }
}
