// `GET /api/history/codex`: every weekly window of the Codex meter with credits
// per percent and api list-price cost. phase two of v4 fills this in; the routes
// are mounted in `app.ts` under `/api/history/codex`.
import { Hono } from 'hono'

export interface CodexHistoryOptions {
  home?: string
  now?: number
}

/** the Codex history routes, mounted at `/api/history/codex` */
export function codexHistoryRoutes(_options: CodexHistoryOptions = {}): Hono {
  const routes = new Hono()
  routes.get('/', (c) => c.json({ error: 'codex history is not built yet' }, 404))
  return routes
}
