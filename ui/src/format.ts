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

/** `/home/thatmike1/git/ccChat-general` reads as `ccChat-general` */
export function projectName(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut >= 0 ? path.slice(cut + 1) : path
}
