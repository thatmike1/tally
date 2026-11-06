// one headless Codex weekly reading, for a machine that runs no Tally server.
//
// an always-on box (the VPS) runs this off a five-minute timer so the account's
// Codex meter is read while the desktop sleeps. it asks the local `codex
// app-server` for `account/rateLimits/read` exactly as the server's own reader
// does, with no conversation or model turn, and appends the reading to the same
// `~/.cache/tally/codex-usage.jsonl` in the same shape. the desktop's sampler
// copies that log into `codex-sources/<name>/` and the page merges it with its
// own readings. `pnpm run build:codex-meter` bundles this file and its server
// imports into one `dist/codex-meter.mjs` that needs only node 22.
import { homedir } from 'node:os'
import {
  codexBinaryPath,
  codexUsagePaths,
  readCodexWeeklyUsage,
  recordCodexFailure,
  recordCodexReading,
  type CodexUsageReading,
} from '../server/codex-usage'

export interface MeterRun {
  ok: boolean
  reading?: CodexUsageReading
  error?: string
}

/** reads the meter once and writes the reading, or the failure, where the server's reader would */
export async function sampleCodexMeter(options: {
  home?: string
  env?: NodeJS.ProcessEnv
  now?: number
  read?: typeof readCodexWeeklyUsage
} = {}): Promise<MeterRun> {
  const home = options.home ?? homedir()
  const paths = codexUsagePaths(home)
  const now = options.now ?? Date.now() / 1000
  const binary = codexBinaryPath(home, options.env ?? process.env)
  if (!binary) {
    // unlike the server, a box that runs the meter on purpose wants to hear Codex is missing
    const error = 'no codex binary found (set CODEX_BIN)'
    recordCodexFailure(paths, now, error)
    return { ok: false, error }
  }
  try {
    const reading = await (options.read ?? readCodexWeeklyUsage)({ now, binary, timeoutMs: 30_000 })
    recordCodexReading(paths, reading)
    return { ok: true, reading }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    recordCodexFailure(paths, now, error)
    return { ok: false, error }
  }
}

async function main(): Promise<number> {
  const run = await sampleCodexMeter()
  // one line for the journal; the reading itself is in the log
  if (run.ok) console.log(`codex-meter: ${run.reading!.usedPercent}% used, resets ${new Date(run.reading!.resetsAt * 1000).toISOString()}`)
  else console.error(`codex-meter: ${run.error}`)
  return run.ok ? 0 : 1
}

// run only as the entry point, so the tests can import the function
if (process.argv[1] && /codex-meter\.(m?js|ts)$/.test(process.argv[1])) {
  main().then((code) => process.exit(code))
}
