// renders and atomically writes the tally sidebar widget for T3 Code.
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { State } from './state'
import { formatHm } from './time'

export interface WidgetRow {
  label: string
}

export interface WidgetData {
  icon: string
  label?: string
  state: 'ok' | 'attention'
  tooltip: string
  rows: WidgetRow[]
  order: number
}

const lastBodies = new Map<string, string>()

/** default location where T3 Code watches for widget json files */
export function defaultWidgetsDir(): string {
  return process.env.T3_WIDGETS_DIR ?? join(homedir(), '.t3', 'userdata', 'widgets')
}

/** derives the 5-hour verdict phrase and formatted reset time */
export function fiveHourVerdict(state: State): { phrase: string; resetTime: string | null } {
  if (!state.fiveHour) {
    return { phrase: 'no samples', resetTime: null }
  }
  if (state.fiveHour.ended) {
    const next = state.fiveHour.nextResetsAt
    return { phrase: 'fresh block', resetTime: next === null ? null : formatHm(next) }
  }
  const resetTime = formatHm(state.fiveHour.resetsAt)
  if (!state.block || !state.block.projection.ready) {
    return { phrase: 'no pace yet', resetTime }
  }
  const projection = state.block.projection
  if (projection.hitsHundredAt !== null && projection.hitsHundredAt !== undefined) {
    return { phrase: `100% at ${formatHm(projection.hitsHundredAt)}`, resetTime }
  }
  return { phrase: 'you make it', resetTime }
}

/** computes attention state based on projection and sampler freshness */
export function computeWidgetState(state: State): 'ok' | 'attention' {
  if (!state.fiveHour) return 'attention'
  // only a broken sampler turns the sidebar orange; a projected 100% is the row's text, not an alarm
  if (state.fiveHour.expired || state.fiveHour.ageSeconds > 900) return 'attention'
  return 'ok'
}

/** formats tooltip with 5h verdict phrase and reset time */
export function computeTooltip(state: State): string {
  const { phrase, resetTime } = fiveHourVerdict(state)
  if (!resetTime) return phrase
  return state.fiveHour?.ended ? `${phrase} · resets ${resetTime} if you start now` : `${phrase} · resets ${resetTime}`
}

/**
 * the three meter lines, the same text the tray menu shows. which sessions ate
 * the block is the page's job, not a glance surface's.
 */
export function computeRows(state: State): WidgetRow[] {
  const rows: WidgetRow[] = []

  if (state.fiveHour) {
    const fivePct = `${Math.round(state.fiveHour.pct)}%`
    const { phrase, resetTime } = fiveHourVerdict(state)
    const resetPart = state.fiveHour.expired
      ? '  ·  expired'
      : !resetTime
        ? ''
        : state.fiveHour.ended
          ? `  ·  resets ${resetTime} if you start now`
          : `  ·  resets ${resetTime}`
    rows.push({ label: `5h  ${fivePct}${resetPart}  ·  ${phrase}` })
  }

  if (state.weekly) {
    const weekPct = `${Math.round(state.weekly.pct)}%`
    const weekPhrase = state.weekly.verdict?.phrase ?? 'on pace'
    rows.push({ label: `week  ${weekPct}  ·  ${weekPhrase}` })
  }

  if (state.fable) {
    const fableModel = state.fable.model ?? 'Fable'
    const fablePct = `${Math.round(state.fable.pct)}%`
    const fablePhrase = state.fable.verdict?.phrase ?? 'on pace'
    rows.push({ label: `${fableModel}  ${fablePct}  ·  ${fablePhrase}` })
  }

  return rows
}

/** renders the full widget payload object */
export function renderWidget(state: State): WidgetData {
  const data: WidgetData = {
    // "activity" is the closest allowed glyph in the fork's icon map to a gauge
    icon: 'activity',
    state: computeWidgetState(state),
    tooltip: computeTooltip(state),
    rows: computeRows(state),
    order: 15,
  }
  if (state.fiveHour) {
    data.label = `${Math.round(state.fiveHour.pct)}%`
  }
  return data
}

/** writes tally.json atomically to dir; skips write if body is unchanged */
export function writeWidget(state: State, dir: string = defaultWidgetsDir()): void {
  try {
    const data = renderWidget(state)
    const body = JSON.stringify(data)
    const filePath = join(dir, 'tally.json')
    if (lastBodies.get(filePath) === body) {
      return
    }
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, '.tally.json.tmp')
    writeFileSync(tmp, body)
    renameSync(tmp, filePath)
    lastBodies.set(filePath, body)
  } catch (error) {
    // a failed write is logged and ignored so the server never crashes on widget errors
    console.error(`tally: failed to write widget: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** removes tally.json from dir on clean shutdown */
export function removeWidget(dir: string = defaultWidgetsDir()): void {
  try {
    const filePath = join(dir, 'tally.json')
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
    lastBodies.delete(filePath)
  } catch (error) {
    console.error(`tally: failed to remove widget: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** resets in-memory body cache; useful for test isolation */
export function resetWidgetCache(): void {
  lastBodies.clear()
}
