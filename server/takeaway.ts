// generates an optional one-line takeaway of what ate the 5-hour block and
// whether the reset is safe, using a cheap model via agy.
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

  if (state.fiveHour) {
    const minsUntilReset = Math.max(0, Math.round((state.fiveHour.resetsAt - state.now) / 60))
    lines.push(`5-hour meter: ${Math.round(state.fiveHour.pct)}% (resets in ${minsUntilReset}m)`)
    if (state.fiveHour.expired) {
      lines.push('Sampler warning: 5-hour sample is expired/behind')
    }
    if (state.fiveHour.maxGap > 600) {
      lines.push(`Sampler warning: max gap between samples is ${Math.round(state.fiveHour.maxGap / 60)}m`)
    }
  }

  if (state.block?.projection) {
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
  return `${state.fiveHour.sampledAt}:${state.block.to}`
}

function cleanText(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface TakeawayOptions {
  runner?: CommandRunner
  model?: string
  timeoutMs?: number
  enabled?: boolean
}

const cache = new Map<string, Promise<TakeawayResult>>()

/** clears in-memory cached takeaway promises, used in tests */
export function resetTakeawayCache(): void {
  cache.clear()
}

/**
 * fetches or returns cached one-line takeaway for the given state.
 * runs `agy -p <prompt> --model gemini-3.8-flash-low --output-format text`.
 */
export async function getTakeaway(
  state: State,
  options: TakeawayOptions = {},
): Promise<TakeawayResult> {
  if (options.enabled === false) {
    return { text: null, model: null }
  }

  const key = takeawayCacheKey(state)
  if (!key) {
    return { text: null, model: null }
  }

  const cached = cache.get(key)
  if (cached) {
    return cached
  }

  const promise = (async (): Promise<TakeawayResult> => {
    try {
      const summary = buildTakeawaySummary(state)
      const prompt = buildTakeawayPrompt(summary)
      const model = options.model ?? 'gemini-3.8-flash-low'
      const timeoutMs = options.timeoutMs ?? 20_000
      const runner = options.runner ?? defaultExecRunner

      const res = await runner('agy', ['-p', prompt, '--model', model, '--output-format', 'text'], timeoutMs)
      if (!res) {
        return { text: null, model: null }
      }
      const text = cleanText(res.stdout)
      if (!text) {
        return { text: null, model: null }
      }
      return { text, model }
    } catch {
      return { text: null, model: null }
    }
  })()

  cache.set(key, promise)
  return promise
}
