// the hash is the router. five routes, one pure parser, so the app never has to
// guess what a location means and the parser can be tested without a browser.

export type Route =
  | { kind: 'today' }
  | { kind: 'history' }
  /** one 5-hour block, identified by its reset key */
  | { kind: 'block'; resetKey: number }
  /** one weekly window, identified by the reset that closes it */
  | { kind: 'week'; resetsAt: number }
  /** `at` freezes the session at a past instant, set when it was opened from a history drill-in */
  | { kind: 'session'; id: string; at?: number }

/** every route that is a page of its own; a session is a drawer over one of these */
export type PageRoute = Exclude<Route, { kind: 'session' }>

/** the hash that leads back to a page, used when the session drawer closes */
export function routeHref(route: PageRoute): string {
  if (route.kind === 'history') return '#/history'
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
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '')
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
  if (head === 'session' && second) {
    // `#/session/<id>/<at>`; an `at` that is not a number is dropped, not the session
    const at = third === undefined ? NaN : Number(third)
    return Number.isFinite(at) ? { kind: 'session', id: second, at } : { kind: 'session', id: second }
  }
  return TODAY
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
