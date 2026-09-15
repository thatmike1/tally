// generates an optional one-line takeaway of what ate the 5-hour block and
// whether the reset is safe, using a cheap model via agy on a background tick.
import { execFile } from 'node:child_process'
import type { State } from './state'

export interface TakeawayResult {
  text: string | null
  model: string | null
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string } | null>

export const defaultExecRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve(null)
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    })
  })

/** builds a compact text summary of the current state for the model */
export function buildTakeawaySummary(state: State): string {
  const lines: string[] = []

  if (state.fiveHour?.ended) {
    const minsSinceReset = Math.max(0, Math.round((state.now - state.fiveHour.resetsAt) / 60))
    lines.push(`5-hour meter: the block reset ${minsSinceReset}m ago and sits at 0% until the next message opens a new one`)
    lines.push(`Previous block ended at ${state.block ? Math.round(state.block.endPct) : '?'}%`)
  } else if (state.fiveHour) {
    const minsUntilReset = Math.max(0, Math.round((state.fiveHour.resetsAt - state.now) / 60))
    lines.push(`5-hour meter: ${Math.round(state.fiveHour.pct)}% (resets in ${minsUntilReset}m)`)
    if (state.fiveHour.expired) {
      lines.push('Sampler warning: 5-hour sample is expired/behind')
    }
    if (state.fiveHour.maxGap > 600) {
      lines.push(`Sampler warning: max gap between samples is ${Math.round(state.fiveHour.maxGap / 60)}m`)
    }
  }

  if (state.block?.projection.ready && !state.fiveHour?.ended) {
    const proj = state.block.projection
    if (proj.hitsHundredAt !== null) {
      lines.push('Projection: will hit 100% before reset')
    } else {
      lines.push(`Projection: safe, ≈${Math.round(proj.pctAtReset)}% at reset`)
    }
  }

  if (state.weekly?.verdict) {
    lines.push(`Weekly meter: ${Math.round(state.weekly.pct)}% (${state.weekly.verdict.phrase})`)
  }

  if (state.fable?.verdict) {
    lines.push(`Fable meter: ${Math.round(state.fable.pct)}% (${state.fable.verdict.phrase})`)
  }

  if (state.split?.sessions && state.split.sessions.length > 0) {
    const topSessions = state.split.sessions
      .slice(0, 3)
      .map((s) => `${Math.round(s.share * 100)}% "${s.title}"`)
    lines.push(`Top block sessions: ${topSessions.join(', ')}`)
  }

  if (state.split) {
    if (state.split.costBeforeFirstSample > 0) {
      lines.push(`Sampler warning: $${state.split.costBeforeFirstSample.toFixed(2)} ran before first sample`)
    }
    if (state.split.costAfterLastSample > 0) {
      lines.push(`Sampler warning: $${state.split.costAfterLastSample.toFixed(2)} ran after last sample`)
    }
  }

  const fableSession = state.week.fable?.sessions?.find(
    (s) => (s.fableShare !== null && s.fableShare > 0) || s.share > 0,
  ) ?? state.week.fable?.sessions?.[0]
  if (fableSession) {
    const share = fableSession.fableShare ?? fableSession.share
    if (share > 0) {
      lines.push(`Top Fable session of the week: ${Math.round(share * 100)}% "${fableSession.title}"`)
    }
  }

  if (state.notes.length > 0) {
    lines.push(`Notes: ${state.notes.join('; ')}`)
  }

  return lines.join('\n')
}

/** formats the prompt instructing the model to produce a tight one-liner */
export function buildTakeawayPrompt(summary: string): string {
  return `Based on this usage data summary:
${summary}

Write one sentence, under 20 words, plain English, no emoji, that says what ate the block and whether the reset is safe.`
}

/** cache key identifying the exact state of the 5-hour block */
export function takeawayCacheKey(state: State): string | null {
  if (!state.fiveHour || !state.block) return null
  return `${state.fiveHour.sampledAt}:${state.block.to}${state.fiveHour.ended ? ':ended' : ''}`
}

function cleanText(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface TakeawayOptions {
  runner?: CommandRunner
  model?: string
  timeoutMs?: number
}

export interface TakeawayRefresher {
  /** runs the model for this state unless the same block state already has text or a run is in flight */
  refresh(state: State): Promise<void>
  /** the last text the model produced, or nulls before the first success */
  current(): TakeawayResult
}

/**
 * keeps the last good one-line takeaway in memory. `agy -p` takes 17 to 29 s,
 * so the server calls `refresh` from its minute tick and the route only reads
 * `current`. only a success moves the cache key, so a failed or timed-out run
 * is retried on the next tick.
 * runs `agy -p <prompt> --model gemini-3.8-flash-low --output-format text`.
 */
export function createTakeawayRefresher(options: TakeawayOptions = {}): TakeawayRefresher {
  const runner = options.runner ?? defaultExecRunner
  const model = options.model ?? 'gemini-3.8-flash-low'
  // nothing waits on the call any more, so the timeout only bounds a hung agy
  const timeoutMs = options.timeoutMs ?? 45_000

  let latest: TakeawayResult = { text: null, model: null }
  let latestKey: string | null = null
  let inFlight: Promise<void> | null = null

  return {
    current: () => latest,
    refresh(state) {
      if (inFlight) return inFlight
      const key = takeawayCacheKey(state)
      if (!key || key === latestKey) return Promise.resolve()

      inFlight = (async () => {
        try {
          const prompt = buildTakeawayPrompt(buildTakeawaySummary(state))
          const res = await runner('agy', ['-p', prompt, '--model', model, '--output-format', 'text'], timeoutMs)
          const text = res ? cleanText(res.stdout) : null
          if (text) {
            latest = { text, model }
            latestKey = key
          }
        } catch {
          // a failed run keeps the last good text and is retried on the next tick
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    },
  }
}
