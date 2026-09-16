// one route with data on it (`/api/state`) plus the built page. everything the
// screen shows is assembled server-side, so the page is one fetch away from
// answering "what ate the block".
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { sessionDetail } from './session-detail'
import { buildState, type Options } from './state'
import type { TakeawayRefresher } from './takeaway'
import { projectsRoot } from './transcripts'

export interface AppConfig extends Options {
  /** absolute path to the built ui, served at / when it exists */
  uiDist?: string | null
  /** the on-demand takeaway generator; null under --no-takeaway */
  takeaway?: Pick<TakeawayRefresher, 'current' | 'refresh'> | null
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
    const weekMode = c.req.query('week') === 'whole' ? 'whole' : 'recent'
    return c.json(await buildState({ ...stateOptions, recordLook: !peek, weekMode }))
  })

  // one session exploded into its parent and subagent transcripts; the lanes
  // link here, and the detail view phase two draws reads exactly this
  app.get('/api/session/:id', async (c) => {
    const id = c.req.param('id')
    const detail = await sessionDetail(id, {
      root: projectsRoot(stateOptions.home ?? homedir()),
      index: stateOptions.index ?? null,
      now: stateOptions.now,
    })
    if (!detail) return c.json({ error: `no transcript for session ${id}` }, 404)
    return c.json(detail)
  })

  // reads the last generated line without spending tokens
  app.get('/api/takeaway', (c) => c.json(takeaway?.current() ?? { text: null, model: null }))

  // the focused, visible page calls this when the user opens or returns to it
  app.post('/api/takeaway', async (c) => {
    if (takeaway) {
      const state = await buildState({ ...stateOptions, recordLook: false })
      await takeaway.refresh(state)
    }
    return c.json(takeaway?.current() ?? { text: null, model: null })
  })

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
