// entry point: binds tally to 127.0.0.1 and opens the page.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { DEFAULT_CCBROWSE } from './ccbrowse'
import { buildState } from './state'
import { defaultWidgetsDir, removeWidget, writeWidget } from './widget'

const DEFAULT_PORT = 1337

export interface Options {
  port: number
  /** cc-browse's base url, or null to skip the day lanes */
  ccbrowse: string | null
  open: boolean
  widget: boolean
}

/** parses `tally [--port <n>] [--ccbrowse <url>|--no-ccbrowse] [--no-open] [--no-widget]` */
export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      ccbrowse: { type: 'string' },
      'no-ccbrowse': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      'no-widget': { type: 'boolean' },
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
  const app = createApp({ uiDist, ccbrowse: options.ccbrowse })

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
  let widgetInterval: NodeJS.Timeout | null = null

  if (options.widget) {
    const updateWidget = async () => {
      try {
        const state = await buildState({ ccbrowse: options.ccbrowse, recordLook: false })
        writeWidget(state, widgetsDir)
      } catch (error) {
        console.error(`tally: widget update failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    void updateWidget()
    widgetInterval = setInterval(updateWidget, 60_000)
    widgetInterval.unref()
  }

  const stop = () => {
    if (widgetInterval) clearInterval(widgetInterval)
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
