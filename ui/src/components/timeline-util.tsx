// pure time and shape helpers for the timeline tab: Prague day bounds, the
// three zoom periods, axis ticks, and how much of a lane falls in a range.
// nothing here touches the dom, so it is tested without a browser.
import { TZ } from '../format'

export const MIN = 60
export const HOUR = 3600
export const DAY = 86400

export type Zoom = 'day' | 'week' | 'since'

/** a stretch of time, unix seconds, `from < to` */
export interface Span {
  from: number
  to: number
}

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** seconds Europe/Prague is ahead of UTC at `t` (3600 in winter, 7200 in summer) */
export function tzOffset(t: number): number {
  const got: Record<string, number> = {}
  for (const part of parts.formatToParts(new Date(Math.floor(t) * 1000))) {
    if (part.type !== 'literal') got[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(got.year!, got.month! - 1, got.day!, got.hour!, got.minute!, got.second!) / 1000
  return asUtc - Math.floor(t)
}

/** local midnight of the Prague day `t` falls in */
export function dayStart(t: number): number {
  const guess = Math.floor((t + tzOffset(t)) / DAY) * DAY - tzOffset(t)
  // on a DST day the offset at midnight differs from the one at `t`
  const fixed = Math.floor((t + tzOffset(guess)) / DAY) * DAY - tzOffset(guess)
  return fixed > t ? fixed - DAY : fixed
}

/** local midnight `n` days after the day `t` falls in */
export function dayAfter(t: number, n = 1): number {
  return dayStart(dayStart(t) + n * DAY + 3 * HOUR)
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** the weekly window as the history reports it */
export interface WeekBounds {
  start: number
  resetsAt: number
}

/**
 * the stretch a zoom level shows around `anchor`. `day` is the Prague calendar
 * day, `week` is the weekly meter's window (Sat to Sat, as the account resets
 * it), `since` everything since the first meter reading up to a little past now.
 */
export function periodOf(zoom: Zoom, anchor: number, weeks: WeekBounds[], since: number, now: number): Span {
  if (zoom === 'day') return { from: dayStart(anchor), to: dayAfter(anchor) }
  if (zoom === 'week') {
    const week = weeks.find((w) => anchor >= w.start && anchor < w.resetsAt)
    if (week) return { from: week.start, to: week.resetsAt }
    const from = dayStart(anchor - 3 * DAY)
    return { from, to: dayAfter(from, 7) }
  }
  return { from: dayStart(since), to: now + 3 * HOUR }
}

/**
 * the zoom that fits a range: a range inside a day reads at day zoom, one inside
 * a week at week zoom, anything longer at since.
 */
export function zoomFor(span: Span): Zoom {
  const length = span.to - span.from
  if (length <= 20 * HOUR && dayStart(span.from) === dayStart(span.to - 1)) return 'day'
  if (length <= 7 * DAY) return 'week'
  return 'since'
}

/**
 * the day zoom trimmed to where something happened: the first and last thing
 * in `marks`, widened to the hour and padded, never past the day itself.
 */
export function trimDay(day: Span, marks: number[]): Span {
  const inside = marks.filter((t) => t >= day.from && t <= day.to)
  if (!inside.length) return day
  const first = Math.min(...inside)
  const last = Math.max(...inside)
  const from = Math.max(day.from, Math.floor(first / HOUR) * HOUR - 30 * MIN)
  const to = Math.min(day.to, Math.ceil(last / HOUR) * HOUR + 30 * MIN)
  // a quiet day with one mark still gets a readable width
  if (to - from < 4 * HOUR) {
    const mid = (from + to) / 2
    return { from: Math.max(day.from, mid - 2 * HOUR), to: Math.min(day.to, mid + 2 * HOUR) }
  }
  return { from, to }
}

export interface Tick {
  t: number
  /** a local midnight: drawn stronger and labelled with the day */
  major: boolean
  label: string
}

const tickDay = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' })
const tickClock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** `Wed 23` */
export function shortDay(t: number): string {
  return tickDay.format(new Date(t * 1000))
}

const TICK_STEPS = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY]

/** axis ticks at least `minGap` pixels apart, on local clock marks */
export function ticks(view: Span, width: number, minGap = 90): Tick[] {
  const span = view.to - view.from
  if (span <= 0 || width <= 0) return []
  const step = TICK_STEPS.find((s) => width / (span / s) >= minGap) ?? 7 * DAY
  const out: Tick[] = []
  if (step >= DAY) {
    for (let t = dayStart(view.from); t <= view.to; t = dayAfter(t, step / DAY)) {
      if (t >= view.from) out.push({ t, major: true, label: shortDay(t) })
    }
    return out
  }
  const offset = tzOffset(view.from)
  for (let t = Math.ceil((view.from + offset) / step) * step - offset; t <= view.to; t += step) {
    const clock = tickClock.format(new Date(t * 1000))
    const major = clock === '00:00'
    out.push({ t, major, label: major ? shortDay(t) : clock })
  }
  return out
}

/** seconds of `segments` that fall inside `range` */
export function activeIn(segments: Span[], range: Span): number {
  let total = 0
  for (const segment of segments) {
    const from = Math.max(segment.from, range.from)
    const to = Math.min(segment.to, range.to)
    if (to > from) total += to - from
  }
  return total
}

/** first and last moment of `segments` inside `range`; null when none reach it */
export function reachIn(segments: Span[], range: Span): Span | null {
  let from = Infinity
  let to = -Infinity
  for (const segment of segments) {
    if (segment.to < range.from || segment.from > range.to) continue
    from = Math.min(from, Math.max(segment.from, range.from))
    to = Math.max(to, Math.min(segment.to, range.to))
  }
  return from <= to ? { from, to } : null
}

/**
 * a model id as a person says it: `claude-opus-5-5` reads `opus 5.5`,
 * `claude-sonnet-5` reads `sonnet 5`, a gpt id loses its dashes.
 */
export function modelName(id: string): string {
  const bare = id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const claude = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(bare)
  if (claude) return `${claude[1]} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  return bare.replace(/^gpt-/, 'gpt ').replace(/-/g, ' ')
}

/** models that are real models, not the transcript's `<synthetic>` placeholder */
export function realModels<T extends { model: string }>(models: T[]): T[] {
  return models.filter((m) => !m.model.startsWith('<'))
}

/** snap `t` to the nearest multiple of `step` seconds */
export function snap(t: number, step: number): number {
  return Math.round(t / step) * step
}

/** the snapping step for a drag at this zoom */
export function snapStep(zoom: Zoom): number {
  return zoom === 'day' ? 5 * MIN : zoom === 'week' ? 30 * MIN : HOUR
}

/** `~4`, `<1`, `~12`: an approximate point figure, never shown as exact */
export function approxPoints(points: number | null): string {
  if (points === null) return 'not measured'
  if (points < 0.5) return points <= 0 ? '0' : '<1'
  return `~${Math.round(points)}`
}

/** `41%`, `<1%`, `0%` */
export function share(value: number): string {
  if (value <= 0) return '0%'
  if (value < 0.005) return '<1%'
  return `${Math.round(value * 100)}%`
}
