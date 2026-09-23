// the small wording helpers the answer page shares: model names as people say
// them, lists joined as prose, a row's name, the effort it ran at. numbers and
// times stay in `format.ts`; this file is about turning them into sentences.
import type { SessionRow, State } from '../api'
import { duration, projectName } from '../format'

/**
 * `claude-opus-5-5` reads as `opus 5.5`, `claude-haiku-4-5-20251001` as
 * `haiku 4.5`. anything that does not look like a Claude id passes through.
 */
export function modelName(model: string): string {
  const bare = model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const match = bare.match(/^([a-z]+)-(\d+(?:-\d+)*)$/)
  return match ? `${match[1]} ${match[2]!.replaceAll('-', '.')}` : bare
}

/** the models a row really ran on, by cost; the `<synthetic>` placeholder lines are not a model */
export function realModels<T extends { model: string }>(models: T[]): T[] {
  return models.filter((one) => !one.model.startsWith('<'))
}

/** `a`, `a and b`, `a, b and c` */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function capital(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** `three`, `12` */
export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}

/** `once`, `twice`, `three times` */
export function timesWord(n: number): string {
  if (n === 1) return 'once'
  if (n === 2) return 'twice'
  return `${countWord(n)} times`
}

/** `1 request`, `4 requests` */
export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
}

/** a points figure is a rounded convenience: `~4`, `~0.6` */
export function points(value: number | null): string {
  if (value === null) return ''
  return `~${value < 1 ? value.toFixed(1) : Math.round(value)}`
}

/** a share of 0..1 as `41%`; a share under half a percent still says it is there */
export function share(value: number): string {
  const percent = value * 100
  if (percent > 0 && percent < 0.5) return '<1%'
  return `${Math.round(percent)}%`
}

/** the T3 title when there is one, else the first thing typed, trimmed to a name */
export function rowName(row: Pick<SessionRow, 'shortTitle' | 'title' | 'sessionId'>): string {
  if (row.shortTitle) return row.shortTitle
  if (row.title) return clip(row.title, 56)
  return row.sessionId.slice(0, 8)
}

/** the shorter form a sentence can carry without the prose running away */
export function sentenceName(row: Pick<SessionRow, 'shortTitle' | 'title' | 'sessionId'>): string {
  if (row.shortTitle) return row.shortTitle
  // a first prompt is not a name, so it reads as a quote
  if (row.title) {
    const words = row.title.trim().split(/\s+/)
    const head = clip(words.slice(0, 6).join(' '), 40)
    return `“${head}${words.length > 6 && !head.endsWith('…') ? '…' : ''}”`
  }
  return row.sessionId.slice(0, 8)
}

/** the line under a row's name: the first prompt when the name is a T3 title, else the project */
export function rowSubtitle(row: Pick<SessionRow, 'shortTitle' | 'title' | 'project'>): string {
  if (row.shortTitle && row.title) return row.title
  return projectName(row.project)
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** the level a session usually runs at; anything else is worth noticing on the page */
export const USUAL_EFFORT = 'high'

/** the recorded effort levels of a row, most requests first, without the unrecorded ones */
export function effortLevels(row: Pick<SessionRow, 'effort'>): string[] {
  return row.effort.flatMap((one) => (one.effort === null ? [] : [one.effort]))
}

/** seconds of activity inside `from..to`, the sum of the stretches rather than first to last */
export function activeWithin(segments: { start: number; end: number }[], from: number, to: number): number {
  return segments.reduce((sum, one) => sum + Math.max(0, Math.min(one.end, to) - Math.max(one.start, from)), 0)
}

/** a working time that is under a minute reads `<1m`, never `23s` next to hours */
export function activeLabel(seconds: number): string {
  return seconds < 60 ? '<1m' : duration(seconds)
}

/** the day lanes by id, so a split row can find its stretches of activity */
export function lanesById(state: State): Map<string, State['day']['lanes'][number]> {
  return new Map(state.day.lanes.map((lane) => [lane.id, lane]))
}

/** the steepest climb of a meter inside a window of `span` seconds; null without a rise */
export function steepestClimb(
  samples: { t: number; pct: number }[],
  span = 35 * 60,
): { from: number; to: number; startPct: number; endPct: number; rise: number } | null {
  let best: { from: number; to: number; startPct: number; endPct: number; rise: number } | null = null
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length && samples[j]!.t - samples[i]!.t <= span; j++) {
      const rise = samples[j]!.pct - samples[i]!.pct
      if (rise > 0 && (!best || rise > best.rise)) {
        best = { from: samples[i]!.t, to: samples[j]!.t, startPct: samples[i]!.pct, endPct: samples[j]!.pct, rise }
      }
    }
  }
  return best
}
