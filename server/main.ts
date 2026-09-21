// entry point: binds tally to 127.0.0.1 and opens the page.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { startCodexUsageReader } from './codex-usage'
import { defaultConfig, tallyConfig } from './config'
import { buildState } from './state'
import { takeawayFromConfig } from './takeaway'
import { TranscriptIndex, type RefreshCounts } from './transcript-index'
import { removeWidget, writeWidget } from './widget'

/** the unit the reset kick starts; `systemd/install.sh` writes it */
const SAMPLER_UNIT = 'tally-sampler.service'

export interface Options {
  port: number
  open: boolean
  widget: boolean
  takeaway: boolean
}

/** parses `tally [--port <n>] [--no-open] [--no-widget] [--no-takeaway]`; the flag wins over the config's port */
export function parseOptions(argv: string[], defaultPort: number = defaultConfig().port): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      'no-widget': { type: 'boolean' },
      'no-takeaway': { type: 'boolean' },
    },
    allowPositionals: false,
  })

  const port = values.port === undefined ? defaultPort : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be between 0 and 65535')

  return {
    port,
    open: !values['no-open'],
    widget: !values['no-widget'],
    takeaway: !values['no-takeaway'],
  }
}

/** the counts one index pass did, as one line in the server log */
function logPass(counts: RefreshCounts): void {
  // the failed count is silent at zero, so a line that mentions it means something
  const failed = counts.failed > 0 ? `, ${counts.failed} failed` : ''
  console.log(
    `tally: index pass in ${counts.seconds.toFixed(1)}s — ${counts.seen} files seen, ${counts.parsed} parsed, ` +
      `${counts.skipped} skipped, ${counts.dropped} dropped${failed}, ${counts.records} records written`,
  )
}

function main(): void {
  const config = tallyConfig()
  let options: Options
  try {
    options = parseOptions(process.argv.slice(2), config.port)
  } catch (error) {
    console.error(`tally: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/dist')
  const takeaway = options.takeaway ? takeawayFromConfig(config.takeaway) : null
  const index = new TranscriptIndex()
  const app = createApp({ uiDist, index, takeaway, config })

  // the first build reads the whole tree, so it runs in the background and the
  // page says it is building; every window falls back to a live scan until the
  // build has reached back far enough
  const indexPass = () => {
    // a pass already running will pick up anything written since it started
    if (index.progress().building) return
    index
      .refresh()
      .then(logPass)
      .catch((error) => console.error(`tally: index pass failed: ${error instanceof Error ? error.message : error}`))
  }
  indexPass()

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port }, (info) => {
    const url = `http://127.0.0.1:${info.port}/`
    console.log(`tally: ${url}`)
    console.log('press Ctrl-C to stop')
    if (options.open) {
      const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
      child.on('error', () => console.error('tally: could not run xdg-open; open the url yourself'))
      child.unref()
    }
  })

  let kickedFor: number | null = null

  // one state build a minute feeds the widget file and the reset kick. the
  // browser requests the Gemini takeaway only while Tally is visible and focused
  const tick = async () => {
    try {
      const state = await buildState({ index, recordLook: false, config })
      const five = state.fiveHour
      // the sampler runs every five minutes; a block that just reset gets read now instead
      if (five?.ended && state.now - five.ageSeconds < five.resetsAt && kickedFor !== five.resetsAt) {
        kickedFor = five.resetsAt
        const child = spawn('systemctl', ['--user', 'start', '--no-block', SAMPLER_UNIT], { stdio: 'ignore' })
        child.on('error', () => console.error(`tally: could not start ${SAMPLER_UNIT}`))
      }
      // the directory is resolved per tick, so installing T3 later starts the widget
      if (options.widget) writeWidget(state)
      // pick up whatever was written since the last pass; an unchanged file is a stat
      indexPass()
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
    index.close()
    if (options.widget) {
      removeWidget()
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
