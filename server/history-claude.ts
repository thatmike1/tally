// `GET /api/history`: every 5-hour block and weekly window since the first
// meter sample, with list cost against measured meter movement. phase two of
// v4 fills this in; the routes are mounted in `app.ts` under `/api/history`.
import { Hono } from 'hono'
import type { TranscriptIndex } from './transcript-index'

export interface HistoryOptions {
  home?: string
  index?: TranscriptIndex | null
  now?: number
}

/** the Claude history routes, mounted at `/api/history` */
export function historyRoutes(_options: HistoryOptions = {}): Hono {
  const routes = new Hono()
  routes.get('/', (c) => c.json({ error: 'claude history is not built yet' }, 404))
  return routes
}
