// the hash is the router. five routes, one pure parser, so the app never has to
// guess what a location means and the parser can be tested without a browser.

export type Route =
  | { kind: 'today' }
  | { kind: 'history' }
  /** the time axis; `from`/`to` pin a picked range, absent means the current block; `view` is what the chart shows */
  | { kind: 'timeline'; from?: number; to?: number; view?: TimelineView }
  /** one 5-hour block, identified by its reset key */
  | { kind: 'block'; resetKey: number }
  /** one weekly window, identified by the reset that closes it */
  | { kind: 'week'; resetsAt: number }
  /** `at` freezes the session at a past instant, set when it was opened from a history drill-in */
  | { kind: 'session'; id: string; at?: number }

/** the timeline's view: a preset button's period around `anchor`, or a free stretch the wheel or a pan left */
export type TimelineView = { preset: 'day' | 'week' | 'since'; anchor: number } | { from: number; to: number }

/** every route that is a page of its own; a session is a drawer over one of these */
export type PageRoute = Exclude<Route, { kind: 'session' }>

/** the hash that leads back to a page, used when the session drawer closes */
export function routeHref(route: PageRoute): string {
  if (route.kind === 'history') return '#/history'
  if (route.kind === 'timeline') return timelineHref(route.from, route.to, route.view)
  if (route.kind === 'block') return blockHref(route.resetKey)
  if (route.kind === 'week') return weekHref(route.resetsAt)
  return '#/'
}

const TODAY: Route = { kind: 'today' }

/**
 * `#/history/block/1757700000` and friends. anything unrecognised, including an
 * empty hash and a non-numeric window key, falls back to today rather than
 * showing an error page: a bad hash is a typo, not a failure.
 */
export function parseRoute(hash: string): Route {
  const [bare = '', query = ''] = hash.split('?', 2)
  const path = bare.replace(/^#\/?/, '').replace(/\/+$/, '')
  if (!path) return TODAY
  const parts = path.split('/').map((part) => decodeURIComponent(part))
  const [head, second, third] = parts

  if (head === 'history') {
    if (second === undefined) return { kind: 'history' }
    const key = Number(third)
    if (!Number.isFinite(key)) return { kind: 'history' }
    if (second === 'block') return { kind: 'block', resetKey: key }
    if (second === 'week') return { kind: 'week', resetsAt: key }
    return { kind: 'history' }
  }
  if (head === 'timeline') {
    // `#/timeline/<from>/<to>`; a half-given or non-numeric range reads as no range
    const from = Number(second)
    const to = Number(third)
    const view = parseView(new URLSearchParams(query).get('v'))
    const route: Route = Number.isFinite(from) && Number.isFinite(to) && to > from ? { kind: 'timeline', from, to } : { kind: 'timeline' }
    return view ? { ...route, view } : route
  }
  if (head === 'session' && second) {
    // `#/session/<id>/<at>`; an `at` that is not a number is dropped, not the session
    const at = third === undefined ? NaN : Number(third)
    return Number.isFinite(at) ? { kind: 'session', id: second, at } : { kind: 'session', id: second }
  }
  return TODAY
}

/** `?v=week@1792000000` or `?v=1792000000-1792003600`; anything else is no view */
function parseView(text: string | null): TimelineView | null {
  if (!text) return null
  const preset = /^(day|week|since)@(\d+)$/.exec(text)
  if (preset) return { preset: preset[1] as 'day' | 'week' | 'since', anchor: Number(preset[2]) }
  const span = /^(\d+)-(\d+)$/.exec(text)
  if (span && Number(span[2]) > Number(span[1])) return { from: Number(span[1]), to: Number(span[2]) }
  return null
}

/** the href of the timeline tab, with a picked range when both ends are given and the view when there is one */
export function timelineHref(from?: number, to?: number, view?: TimelineView): string {
  const base = from !== undefined && to !== undefined ? `#/timeline/${Math.round(from)}/${Math.round(to)}` : '#/timeline'
  if (!view) return base
  return 'preset' in view ? `${base}?v=${view.preset}@${Math.round(view.anchor)}` : `${base}?v=${Math.round(view.from)}-${Math.round(view.to)}`
}

/** the href a block tile points at */
export function blockHref(resetKey: number): string {
  return `#/history/block/${resetKey}`
}

/** the href a week tile points at */
export function weekHref(resetsAt: number): string {
  return `#/history/week/${resetsAt}`
}

/** the href every session title on the page points at; `at` freezes it, for a frozen page's links */
export function sessionHref(sessionId: string, at?: number): string {
  const base = `#/session/${encodeURIComponent(sessionId)}`
  return at === undefined ? base : `${base}/${Math.round(at)}`
}
