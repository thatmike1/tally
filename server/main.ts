// entry point: binds tally to 127.0.0.1 and opens the page.
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { startCodexUsageReader } from './codex-usage'
import { defaultConfig, tallyConfig } from './config'
import { bootedBySystemd, inProcessSampler, systemdSampler } from './sampler'
import { buildState } from './state'
import { takeawayFromConfig } from './takeaway'
import { TranscriptIndex, type RefreshCounts } from './transcript-index'
import { removeWidget, writeWidget } from './widget'

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

/**
 * how to open a url in the default browser: `xdg-open` on linux, and on windows
 * the url protocol handler, which takes the url as one argument with no shell
 * quoting to get wrong
 */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/** the counts one index pass did, as one line in the server log */
function logPass(counts: RefreshCounts): void {
  // the failed count is silent at zero, so a line that mentions it means something
  const failed = counts.failed > 0 ? `, ${counts.failed} failed` : ''
  // silent too once no file is left under an older parser
  const reread = counts.reread > 0 || counts.stale > 0 ? `, ${counts.reread} reread for a new field (${counts.stale} to go)` : ''
  console.log(
    `tally: index pass in ${counts.seconds.toFixed(1)}s — ${counts.seen} files seen, ${counts.parsed} parsed, ` +
      `${counts.skipped} skipped, ${counts.dropped} dropped${failed}, ${counts.records} records written${reread}`,
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
  let passRunning = false
  const indexPass = () => {
    // a pass already running will pick up anything written since it started
    if (passRunning) return
    passRunning = true
    index
      .refresh()
      .then((counts) => {
        logPass(counts)
        passRunning = false
        // files left under an older parser: the next slice of the reread starts
        // right away, and each pass takes the changed files first, so the page
        // stays a few seconds fresh while the reread runs
        if (counts.stale > 0) setImmediate(indexPass)
      })
      .catch((error) => {
        passRunning = false
        console.error(`tally: index pass failed: ${error instanceof Error ? error.message : error}`)
      })
  }
  indexPass()

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port }, (info) => {
    const url = `http://127.0.0.1:${info.port}/`
    console.log(`tally: ${url}`)
    console.log('press Ctrl-C to stop')
    if (options.open) {
      const opener = openCommand(url)
      const child = spawn(opener.command, opener.args, { stdio: 'ignore', detached: true })
      child.on('error', () => console.error(`tally: could not run ${opener.command}; open the url yourself`))
      child.unref()
    }
  })

  // systemd's timer samples on linux; anywhere else the server runs the sampler itself
  const sampler = bootedBySystemd() ? systemdSampler() : inProcessSampler(config.python)
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
        sampler.kick()
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
    sampler.stop()
    codexUsage.stop()
    index.close()
    if (options.widget) {
      removeWidget()
    }
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  if (process.platform === 'win32') {
    // Ctrl-Break, and the console window closing; windows never sends SIGTERM
    process.on('SIGBREAK', stop)
    process.on('SIGHUP', stop)
  }
}

// only run when executed, so tests can import the helpers
if (process.argv[1] && import.meta.url.startsWith('file:') && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
