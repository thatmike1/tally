// entry point: binds tally to 127.0.0.1 and opens the page.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { DEFAULT_CCBROWSE } from './ccbrowse'
import { startCodexUsageReader } from './codex-usage'
import { buildState } from './state'
import { createTakeawayRefresher } from './takeaway'
import { defaultWidgetsDir, removeWidget, writeWidget } from './widget'

const DEFAULT_PORT = 1337

export interface Options {
  port: number
  /** cc-browse's base url, or null to skip the day lanes */
  ccbrowse: string | null
  open: boolean
  widget: boolean
  takeaway: boolean
}

/** parses `tally [--port <n>] [--ccbrowse <url>|--no-ccbrowse] [--no-open] [--no-widget] [--no-takeaway]` */
export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      ccbrowse: { type: 'string' },
      'no-ccbrowse': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      'no-widget': { type: 'boolean' },
      'no-takeaway': { type: 'boolean' },
    },
    allowPositionals: false,
  })

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be between 0 and 65535')

  return {
    port,
    ccbrowse: values['no-ccbrowse'] ? null : (values.ccbrowse ?? DEFAULT_CCBROWSE),
    open: !values['no-open'],
    widget: !values['no-widget'],
    takeaway: !values['no-takeaway'],
  }
}

function main(): void {
  let options: Options
  try {
    options = parseOptions(process.argv.slice(2))
  } catch (error) {
    console.error(`tally: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/dist')
  const takeaway = options.takeaway ? createTakeawayRefresher() : null
  const app = createApp({ uiDist, ccbrowse: options.ccbrowse, takeaway })

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port }, (info) => {
    const url = `http://127.0.0.1:${info.port}/`
    console.log(`tally: ${url}`)
    if (options.ccbrowse) console.log(`day lanes from cc-browse: ${options.ccbrowse}`)
    console.log('press Ctrl-C to stop')
    if (options.open) {
      const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
      child.on('error', () => console.error('tally: could not run xdg-open; open the url yourself'))
      child.unref()
    }
  })

  const widgetsDir = defaultWidgetsDir()
  let kickedFor: number | null = null

  // one state build a minute feeds the widget file, the takeaway (in the
  // background, agy takes longer than a request should wait) and the reset kick
  const tick = async () => {
    try {
      const state = await buildState({ ccbrowse: options.ccbrowse, recordLook: false })
      const five = state.fiveHour
      // the sampler runs every five minutes; a block that just reset gets read now instead
      if (five?.ended && state.now - five.ageSeconds < five.resetsAt && kickedFor !== five.resetsAt) {
        kickedFor = five.resetsAt
        const child = spawn('systemctl', ['--user', 'start', '--no-block', 'usage-sample.service'], { stdio: 'ignore' })
        child.on('error', () => console.error('tally: could not start usage-sample.service'))
      }
      if (options.widget) writeWidget(state, widgetsDir)
      if (takeaway) void takeaway.refresh(state)
    } catch (error) {
      console.error(`tally: minute tick failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const codexUsage = startCodexUsageReader({ onUpdate: tick })
  void tick()
  const tickInterval = setInterval(tick, 60_000)
  tickInterval.unref()

  const stop = () => {
    clearInterval(tickInterval)
    codexUsage.stop()
    if (options.widget) {
      removeWidget(widgetsDir)
    }
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// only run when executed, so tests can import the helpers
if (process.argv[1] && import.meta.url.startsWith('file:') && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
