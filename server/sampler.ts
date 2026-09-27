// who runs `sampler/usage-sample.py`, the five-minute meter reading everything
// else is drawn from.
//
// on linux `systemd/install.sh` puts it on a user timer (`OnCalendar=*:0/5`)
// and the server only asks systemd to start it early, when a block has just
// reset. a machine that was not booted by systemd (windows) has no timer, so the
// server runs the script itself: on the same wall-clock five-minute marks, never
// two runs at once, and once at startup when the log's newest reading is
// already a period old, the way `Persistent=true` catches a missed timer up.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLog } from './samples'

/** the unit the reset kick starts; `systemd/install.sh` writes it */
export const SAMPLER_UNIT = 'tally-sampler.service'

/** seconds between samples: the timer's `*:0/5` */
export const SAMPLE_PERIOD = 300

/**
 * the longest one wait is allowed to be. a timer's clock may stop while the
 * machine sleeps, so the wall clock is checked at least this often and a mark
 * slept through is caught up within it of waking
 */
const MAX_WAIT_MS = 60_000

/** a run still going after this is stuck (the script's own timeouts are 20 s a request, 40 s an ssh) */
const RUN_TIMEOUT_MS = 4 * 60_000

export const SAMPLER_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../sampler/usage-sample.py')

/** what the server does about sampling: `kick` samples now, `stop` ends any schedule */
export interface Sampler {
  kick(): void
  stop(): void
}

/** a python to run the script with: the command and the arguments before the script */
export interface Interpreter {
  command: string
  args: string[]
}

/** true when systemd booted this machine, by sd_booted()'s own test; then the timer samples */
export function bootedBySystemd(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): boolean {
  return platform === 'linux' && exists('/run/systemd/system')
}

/** the linux sampler: the timer runs it, and a kick asks systemd for one run now */
export function systemdSampler(): Sampler {
  return {
    kick() {
      const child = spawn('systemctl', ['--user', 'start', '--no-block', SAMPLER_UNIT], { stdio: 'ignore' })
      child.on('error', () => console.error(`tally: could not start ${SAMPLER_UNIT}`))
    },
    stop() {},
  }
}

/** the unix time of the first five-minute mark strictly after `now` */
export function nextMark(now: number, period = SAMPLE_PERIOD): number {
  return (Math.floor(now / period) + 1) * period
}

/**
 * the pythons to try, in order: the config's `python`, then `python`, then the
 * windows launcher as `py -3`. elsewhere `python3` comes before `python`, which
 * is still python 2 on some machines.
 */
export function interpreterCandidates(configured: string | null, platform: NodeJS.Platform = process.platform): Interpreter[] {
  const out: Interpreter[] = configured ? [{ command: configured, args: [] }] : []
  if (platform === 'win32') out.push({ command: 'python', args: [] }, { command: 'py', args: ['-3'] })
  else out.push({ command: 'python3', args: [] }, { command: 'python', args: [] })
  return out
}

/**
 * true when the interpreter starts and says it is python 3. on windows a bare
 * `python` is often the Microsoft Store stub, which exists on the PATH, prints
 * an install hint and exits 9009, so being on the PATH is not enough.
 */
export function answersAsPython3(interpreter: Interpreter): boolean {
  const run = spawnSync(interpreter.command, [...interpreter.args, '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  return run.status === 0 && /^Python 3\./.test(`${run.stdout ?? ''}${run.stderr ?? ''}`.trim())
}

/** the first candidate that answers as python 3, or null */
export function pickInterpreter(candidates: Interpreter[], probe: (interpreter: Interpreter) => boolean = answersAsPython3): Interpreter | null {
  return candidates.find((candidate) => probe(candidate)) ?? null
}

/** one run of the script; resolves when it has exited, and never rejects */
export function runScript(interpreter: Interpreter, script = SAMPLER_SCRIPT): Promise<void> {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(interpreter.command, [...interpreter.args, script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    const keep = (chunk: Buffer) => {
      // the tail is what explains a failure; a traceback is never this long
      output = (output + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      console.error(`tally: could not run the sampler: ${error.message}`)
      done()
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      if (code === 0) console.log(`tally: sampler ran in ${seconds}s`)
      else console.error(`tally: sampler exited ${code ?? signal} after ${seconds}s${output.trim() ? `:\n${output.trim()}` : ''}`)
      done()
    })
  })
}

export interface ScheduleOptions {
  /** one sampler run; the schedule never starts a second while one is in flight */
  run: () => Promise<void>
  /** unix seconds; injected by tests */
  now?: () => number
  /** when the log was last read by the sampler, in unix seconds; null for never */
  lastRead?: () => number | null
  period?: number
}

/**
 * runs `run` on every wall-clock mark of `period` seconds, and right away when
 * the last reading is a whole period old. a mark that comes while a run is in
 * flight is skipped, not queued, the way a oneshot unit that is still active
 * ignores its timer.
 */
export function scheduleSampler(options: ScheduleOptions): Sampler {
  const now = options.now ?? (() => Date.now() / 1000)
  const period = options.period ?? SAMPLE_PERIOD
  let running = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const kick = () => {
    if (running || stopped) return
    running = true
    options
      .run()
      .catch((error) => console.error(`tally: sampler run failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running = false
      })
  }

  let target = nextMark(now(), period)
  const wake = () => {
    if (stopped) return
    const at = now()
    if (at >= target) {
      kick()
      // from the wall clock, not target + period: after a sleep that skipped
      // several marks, one run catches up and the next one is on the grid
      target = nextMark(at, period)
    }
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, Math.ceil((target - now()) * 1000)))
    timer = setTimeout(wake, wait)
    timer.unref?.()
  }

  const last = options.lastRead?.() ?? null
  if (last === null || now() - last >= period) kick()
  wake()

  return {
    kick,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/**
 * the sampler for a machine without systemd: the server runs the script on the
 * five-minute marks. with no python 3 to run it there is nothing to schedule,
 * and the page says the sampler is behind.
 */
export function inProcessSampler(configuredPython: string | null, logPath?: string): Sampler {
  const candidates = interpreterCandidates(configuredPython)
  const interpreter = pickInterpreter(candidates)
  if (!interpreter) {
    const tried = candidates.map((c) => [c.command, ...c.args].join(' ')).join(', ')
    console.error(`tally: no python 3 found (tried ${tried}), so the meters are not sampled; set "python" in the config`)
    return { kick() {}, stop() {} }
  }
  if (configuredPython && interpreter.command !== configuredPython) {
    console.error(`tally: the configured python (${configuredPython}) does not answer as python 3, so the sampler falls back`)
  }
  console.log(`tally: sampling every ${SAMPLE_PERIOD / 60} minutes with ${[interpreter.command, ...interpreter.args].join(' ')}`)
  return scheduleSampler({
    run: () => runScript(interpreter),
    lastRead: () => readLog(logPath).lastRead,
  })
}
