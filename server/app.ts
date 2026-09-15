// one route with data on it (`/api/state`) plus the built page. everything the
// screen shows is assembled server-side, so the page is one fetch away from
// answering "what ate the block".
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { buildState, type Options } from './state'
import type { TakeawayRefresher } from './takeaway'

export interface AppConfig extends Options {
  /** absolute path to the built ui, served at / when it exists */
  uiDist?: string | null
  /** the background takeaway the route reads; null under --no-takeaway */
  takeaway?: Pick<TakeawayRefresher, 'current'> | null
}

export function createApp(config: AppConfig = {}) {
  const { uiDist = null, takeaway = null, ...stateOptions } = config
  const app = new Hono()

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : 'server error'
    return c.json({ error: message }, 500)
  })

  app.get('/api/state', async (c) => {
    // `?peek` reads the page without moving the "last looked" marker, which is
    // what the tray face will want
    const peek = c.req.query('peek') !== undefined
    return c.json(await buildState({ ...stateOptions, recordLook: !peek }))
  })

  // never runs the model: the server's minute tick refreshes it in the background
  app.get('/api/takeaway', (c) => c.json(takeaway?.current() ?? { text: null, model: null }))

  if (uiDist && existsSync(uiDist)) {
    app.use('/*', serveStatic({ root: uiDist }))
    app.get('/*', serveStatic({ path: `${uiDist}/index.html` }))
  } else {
    app.get('/', (c) =>
      c.text('tally: the ui is not built yet. run `npm run build`, or `npm run dev` for the vite server.', 503),
    )
  }

  return app
}
