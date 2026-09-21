// one route with data on it (`/api/state`) plus the built page. everything the
// screen shows is assembled server-side, so the page is one fetch away from
// answering "what ate the block".
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { defaultConfig } from './config'
import { sessionDetail } from './session-detail'
import { codexSessionDetail, codexSessionsRoot } from './codex-sessions'
import { statePath } from './t3'
import { codexHistoryRoutes } from './history-codex'
import { historyRoutes } from './history-claude'
import { buildState, type Options } from './state'
import type { TakeawayRefresher } from './takeaway'
import { projectsRoot } from './transcripts'

export interface AppConfig extends Options {
  /** absolute path to the built ui, served at / when it exists */
  uiDist?: string | null
  /** the on-demand takeaway generator; null under --no-takeaway */
  takeaway?: Pick<TakeawayRefresher, 'current' | 'refresh'> | null
}

export function createApp(options: AppConfig = {}) {
  const { uiDist = null, takeaway = null, ...stateOptions } = options
  // the config the routes read; `stateOptions` carries it on to `buildState`
  const config = stateOptions.config ?? defaultConfig()
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
    // `?at=<unix seconds>` freezes the page at that instant for the history drill-in
    const atRaw = c.req.query('at')
    const at = atRaw === undefined ? undefined : Number(atRaw)
    if (at !== undefined && !Number.isFinite(at)) return c.json({ error: 'at must be unix seconds' }, 400)
    if (at !== undefined) return c.json(await buildState({ ...stateOptions, recordLook: false, weekMode: 'whole', at }))
    return c.json(await buildState({ ...stateOptions, recordLook: !peek, weekMode }))
  })

  // one session exploded into its parent and subagent transcripts; the lanes
  // link here, and the detail view phase two draws reads exactly this
  app.get('/api/session/:id', async (c) => {
    const id = c.req.param('id')
    if (id.startsWith('codex:')) {
      // `?at=<unix seconds>` freezes the thread for a history drill-in, as on /api/state
      const atRaw = c.req.query('at')
      const at = atRaw === undefined ? undefined : Number(atRaw)
      if (at !== undefined && !Number.isFinite(at)) return c.json({ error: 'at must be unix seconds' }, 400)
      const codexDetail = await codexSessionDetail(id.slice('codex:'.length), {
        root: codexSessionsRoot(stateOptions.home ?? homedir()),
        t3: statePath(stateOptions.home ?? homedir()),
        now: stateOptions.now,
        at,
        agentsviewUrl: config.agentsviewUrl,
      })
      if (!codexDetail) {
        return c.json({ error: at === undefined ? `no rollout for codex thread ${id}` : `no rollout for codex thread ${id} written by ${at}` }, 404)
      }
      return c.json(codexDetail)
    }
    const detail = await sessionDetail(id, {
      root: projectsRoot(stateOptions.home ?? homedir()),
      index: stateOptions.index ?? null,
      now: stateOptions.now,
      agentsviewUrl: config.agentsviewUrl,
    })
    if (!detail) return c.json({ error: `no transcript for session ${id}` }, 404)
    return c.json(detail)
  })

  // the codex routes mount first so `/api/history/codex` is not swallowed by `/api/history`
  app.route(
    '/api/history/codex',
    codexHistoryRoutes({
      home: stateOptions.home,
      now: stateOptions.now,
      plan: config.codexPlan,
      installed: stateOptions.codexInstalled,
    }),
  )
  app.route(
    '/api/history',
    historyRoutes({ home: stateOptions.home, index: stateOptions.index, now: stateOptions.now, plan: config.plan }),
  )

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
