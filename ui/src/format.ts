// every time on the page is Europe/Prague, formatted from a unix timestamp.
export const TZ = 'Europe/Prague'

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })

/** `23:20` */
export function hm(t: number): string {
  return clock.format(new Date(t * 1000))
}

/** `Sat 23:00` */
export function dayClock(t: number): string {
  return `${weekday.format(new Date(t * 1000))} ${hm(t)}`
}

/** `1 h 31`, `24 min` — how long until something */
export function until(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`
}

/** `1h 32m`, `4m`, `11s` — a span that already happened */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** how stale a reading is, for the small note under a number */
export function ago(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 90) return 'just now'
  return `${duration(total)} ago`
}

export function money(value: number | null): string {
  if (value === null) return ''
  if (value < 0.01) return '<1c'
  return value < 100 ? `$${value.toFixed(2)}` : `$${Math.round(value)}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * a strip label that reads on its segment: the palette's pale greys take dark
 * text whatever the theme, since the segment colour does not change with it
 */
export function labelOn(background: string): string | undefined {
  const value = Number.parseInt(background.slice(1), 16)
  const luma = 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)
  return luma > 155 ? '#1c1b19' : undefined
}

export function pct(value: number): string {
  return `${Math.round(value)}%`
}

/**
 * the group label for a lane's project.
 *
 * `/home/thatmike1/git/ccChat-general` reads as `ccChat-general`. a project the
 * server could not resolve against the filesystem arrives as Claude's encoded
 * name (`-home-thatmike1-git-old-thing`), which has no slash in it: the piece
 * after the last dash is the closest thing to a directory name it carries.
 */
export function projectName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut >= 0) return trimmed.slice(cut + 1)
  if (trimmed.startsWith('-')) {
    const dash = trimmed.lastIndexOf('-')
    if (dash > 0) return trimmed.slice(dash + 1)
  }
  return trimmed
}

/** `6d 19h`, `5h 12m`, `8m` — how long until something days away */
export function days(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds / 60))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

const dateParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** `Mon 8 Sep` — the day a window belongs to, never hand-typed */
export function dayDate(t: number): string {
  return dateParts
    .formatToParts(new Date(t * 1000))
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value)
    .join(' ')
}

/** `2026-09-08` in Europe/Prague, for grouping windows into days */
export function dayKey(t: number): string {
  return isoDay.format(new Date(t * 1000))
}

/**
 * a rate in dollars, which `money` rounds too hard: `$0.84`, `$1.20`, `$12.4`.
 * null is the caller's problem — it means "not measured" and never prints as 0.
 */
export function rate(value: number): string {
  if (value >= 10) return `$${value.toFixed(1)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(3)}`
}

/** `4.2×`, `0.31×` — a ratio of two token counts */
export function ratio(value: number | null): string {
  if (value === null) return 'not measured'
  if (value >= 10) return `${Math.round(value)}×`
  return value >= 1 ? `${value.toFixed(1)}×` : `${value.toFixed(2)}×`
}
