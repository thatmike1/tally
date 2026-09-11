// every time on the page is Europe/Prague, computed from a unix timestamp,
// never typed. the mock's hand-written reset times were wrong twice.
export const TZ = 'Europe/Prague'

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })

/** `2026-09-11` for the Prague calendar day containing this instant */
export function dayKey(t: number): string {
  return dayFormat.format(new Date(t * 1000))
}

/** `Mon` … `Sun`, in Prague */
export function weekdayName(t: number): string {
  return weekdayFormat.format(new Date(t * 1000))
}

export function isWeekend(t: number): boolean {
  const name = weekdayName(t)
  return name === 'Sat' || name === 'Sun'
}

/** seconds Prague is ahead of UTC at this instant */
function offsetAt(t: number): number {
  const parts = partsFormat.formatToParts(new Date(t * 1000))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc =
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) / 1000
  return asUtc - t
}

/** unix seconds of Prague midnight starting `2026-09-11`; DST-safe by re-solving once */
export function startOfDay(key: string): number {
  const naive = Date.parse(`${key}T00:00:00Z`) / 1000
  let t = naive - offsetAt(naive)
  t = naive - offsetAt(t)
  return t
}

/** the Prague day containing `t`, as [start, end) in unix seconds */
export function dayBounds(t: number): [number, number] {
  const start = startOfDay(dayKey(t))
  // 24h then snapped, so a DST day is 23 or 25 hours rather than silently wrong
  const end = startOfDay(dayKey(start + 36 * 3600))
  return [start, end]
}

/** Prague weekdays (Mon-Fri) touched by [from, to), the current day included */
export function workdaysBetween(from: number, to: number): number {
  if (to <= from) return 0
  let count = 0
  let cursor = startOfDay(dayKey(from))
  while (cursor < to) {
    if (!isWeekend(cursor)) count++
    cursor = startOfDay(dayKey(cursor + 36 * 3600))
  }
  return count
}
