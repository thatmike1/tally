// reads Codex's account-level weekly allowance and keeps a small local history.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatHm, weekdayName } from './time'

export const CODEX_WEEK_MINUTES = 7 * 24 * 60
export const CODEX_STALE_SECONDS = 15 * 60
/** a day's cycle has to be inside the average, or one morning's sitting projects to a false 100% */
export const CODEX_MIN_PACE_SECONDS = 24 * 3600
/** the reader runs every five minutes, so a longer silence is a gap */
export const CODEX_GAP_SECONDS = 30 * 60
export const CODEX_HISTORY_STEP = 15 * 60
/** readings of one window agree on the reset to within this */
const RESET_JITTER_SECONDS = 120
const REQUEST_TIMEOUT_MS = 10_000

export interface CodexUsageReading {
  sampledAt: number
  usedPercent: number
  resetsAt: number
  windowDurationMins: number
}

interface CodexReadStatus {
  checkedAt: number
  ok: boolean
  error?: string
}

interface RateLimitWindow {
  usedPercent?: unknown
  resetsAt?: unknown
  windowDurationMins?: unknown
}

interface RateLimitSnapshot {
  limitId?: unknown
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
}

interface RateLimitsResponse {
  rateLimits?: RateLimitSnapshot | null
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null
}

/**
 * the weekly verdict. the meter is cumulative since the window opened, so the
 * latest reading alone gives the week's average burn; history picks the window
 * and draws the line, and a gap in it never biases the rate.
 */
export interface CodexPace {
  ready: boolean
  /** why there is no projection, null when there is one */
  reason: string | null
  /** where the meter would sit at the latest reading if the week burned evenly */
  evenPct: number
  /** where the meter lands at the reset if the week's average holds */
  pctAtReset: number | null
  /** when it reaches 100 at that average, null if it does not before the reset */
  hitsHundredAt: number | null
  /** the short text the tray, widget and page share */
  phrase: string
}

export interface CodexHistoryPoint {
  t: number
  pct: number
  /** the reader missed more than `CODEX_GAP_SECONDS` before this point */
  afterGap: boolean
}

export interface CodexUsageView {
  status: 'fresh' | 'stale' | 'unavailable'
  line: string
  usedPercent: number | null
  resetsAt: number | null
  sampledAt: number | null
  ageSeconds: number | null
  /** reset minus the window's duration; null when there is no current window */
  windowStart: number | null
  /** null unless the reading is fresh */
  pace: CodexPace | null
  /** the current window's readings, thinned to one per `CODEX_HISTORY_STEP` */
  history: CodexHistoryPoint[]
}

export interface CodexUsagePaths {
  history: string
  status: string
}

/** local files for Codex readings; neither contains authentication data */
export function codexUsagePaths(home: string = homedir()): CodexUsagePaths {
  const dir = join(home, '.cache', 'tally')
  return { history: join(dir, 'codex-usage.jsonl'), status: join(dir, 'codex-usage-status.json') }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** picks the seven-day window from the main Codex bucket, regardless of position */
export function selectCodexWeeklyWindow(response: RateLimitsResponse, sampledAt: number): CodexUsageReading | null {
  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits
  if (!snapshot || (snapshot.limitId && snapshot.limitId !== 'codex')) return null
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window) continue
    const duration = finiteNumber(window.windowDurationMins)
    const usedPercent = finiteNumber(window.usedPercent)
    const resetsAt = finiteNumber(window.resetsAt)
    if (duration !== CODEX_WEEK_MINUTES || usedPercent === null || resetsAt === null || resetsAt <= 0) continue
    return {
      sampledAt,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt,
      windowDurationMins: duration,
    }
  }
  return null
}

function writeStatus(path: string, status: CodexReadStatus): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(status))
  renameSync(temporary, path)
}

export function recordCodexReading(paths: CodexUsagePaths, reading: CodexUsageReading): void {
  mkdirSync(dirname(paths.history), { recursive: true })
  appendFileSync(paths.history, `${JSON.stringify(reading)}\n`)
  writeStatus(paths.status, { checkedAt: reading.sampledAt, ok: true })
}

export function recordCodexFailure(paths: CodexUsagePaths, checkedAt: number, error: string): void {
  writeStatus(paths.status, { checkedAt, ok: false, error })
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function readCodexHistory(path: string): CodexUsageReading[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as CodexUsageReading
          return Number.isFinite(value.sampledAt) && Number.isFinite(value.usedPercent) && Number.isFinite(value.resetsAt)
            ? [value]
            : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function countdown(seconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** `Thu 14:00` in Europe/Prague */
function dayClock(t: number): string {
  return `${weekdayName(t)} ${formatHm(t)}`
}

/** the readings that belong to the latest reading's window, oldest first */
export function currentWindowReadings(history: CodexUsageReading[]): CodexUsageReading[] {
  const latest = history.at(-1)
  if (!latest) return []
  return history.filter(
    (reading) =>
      reading.windowDurationMins === latest.windowDurationMins &&
      Math.abs(reading.resetsAt - latest.resetsAt) <= RESET_JITTER_SECONDS &&
      reading.sampledAt <= latest.sampledAt,
  )
}

/** one point per history step, the last reading of each, marking where the reader went quiet */
export function thinHistory(readings: CodexUsageReading[]): CodexHistoryPoint[] {
  const points: CodexHistoryPoint[] = []
  let previous: CodexUsageReading | null = null
  for (const reading of readings) {
    const afterGap = previous !== null && reading.sampledAt - previous.sampledAt > CODEX_GAP_SECONDS
    const last = points.at(-1)
    if (last && !afterGap && Math.floor(last.t / CODEX_HISTORY_STEP) === Math.floor(reading.sampledAt / CODEX_HISTORY_STEP)) {
      last.t = reading.sampledAt
      last.pct = reading.usedPercent
    } else {
      points.push({ t: reading.sampledAt, pct: reading.usedPercent, afterGap })
    }
    previous = reading
  }
  return points
}

/** projects the week from the window's average burn, or says why it cannot yet */
export function codexPace(window: CodexUsageReading[]): CodexPace | null {
  const latest = window.at(-1)
  if (!latest) return null
  const duration = latest.windowDurationMins * 60
  const windowStart = latest.resetsAt - duration
  const elapsed = latest.sampledAt - windowStart
  const evenPct = Math.min(100, Math.max(0, (elapsed / duration) * 100))
  const waiting = (reason: string): CodexPace => ({ ready: false, reason, evenPct, pctAtReset: null, hitsHundredAt: null, phrase: 'no pace yet' })
  if (latest.usedPercent >= 100) {
    return { ready: true, reason: null, evenPct, pctAtReset: 100, hitsHundredAt: latest.sampledAt, phrase: 'at 100%' }
  }
  if (elapsed < CODEX_MIN_PACE_SECONDS) return waiting('under a day into the week')
  const peak = Math.max(...window.map((reading) => reading.usedPercent))
  // the average assumes the meter only climbs inside a window; a drop means it was reset early
  if (latest.usedPercent < peak) return waiting('the meter went down inside this week')
  const rate = latest.usedPercent / elapsed
  const projected = latest.usedPercent + rate * (latest.resetsAt - latest.sampledAt)
  if (projected >= 100) {
    const hitsHundredAt = latest.sampledAt + (100 - latest.usedPercent) / rate
    return { ready: true, reason: null, evenPct, pctAtReset: 100, hitsHundredAt, phrase: `100% by ${dayClock(hitsHundredAt)}` }
  }
  return { ready: true, reason: null, evenPct, pctAtReset: projected, hitsHundredAt: null, phrase: `≈ ${Math.round(projected)}% at reset` }
}

/** gives both glance surfaces and the page one canonical, honest reading */
export function codexUsageView(paths: CodexUsagePaths, now: number): CodexUsageView {
  const status = readJson<CodexReadStatus>(paths.status)
  const readings = readCodexHistory(paths.history)
  const latest = readings.at(-1) ?? null
  const empty = { windowStart: null, pace: null, history: [] }
  if (!latest || !status) {
    return { status: 'unavailable', line: 'Codex · unavailable', usedPercent: null, resetsAt: null, sampledAt: null, ageSeconds: null, ...empty }
  }
  const ageSeconds = Math.max(0, now - latest.sampledAt)
  if (latest.resetsAt <= now) {
    return { status: 'unavailable', line: 'Codex · awaiting new weekly reading', usedPercent: null, resetsAt: null, sampledAt: latest.sampledAt, ageSeconds, ...empty }
  }
  const window = currentWindowReadings(readings)
  const windowStart = latest.resetsAt - latest.windowDurationMins * 60
  const history = thinHistory(window)
  if (!status.ok || now - status.checkedAt > CODEX_STALE_SECONDS || ageSeconds > CODEX_STALE_SECONDS) {
    return { status: 'stale', line: 'Codex · usage unavailable (last reading stale)', usedPercent: null, resetsAt: latest.resetsAt, sampledAt: latest.sampledAt, ageSeconds, windowStart, pace: null, history }
  }
  const rounded = Math.round(latest.usedPercent)
  const pace = codexPace(window)
  return {
    status: 'fresh',
    line: `Codex · ${rounded}% used · resets in ${countdown(latest.resetsAt - now)}${pace ? ` · ${pace.phrase}` : ''}`,
    usedPercent: latest.usedPercent,
    resetsAt: latest.resetsAt,
    sampledAt: latest.sampledAt,
    ageSeconds,
    windowStart,
    pace,
    history,
  }
}

function send(child: ChildProcessWithoutNullStreams, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

/** finds Codex in the service's PATH or common user-level install locations */
export function codexBinaryPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.CODEX_BIN,
    ...(env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'codex')),
    join(home, '.bun', 'bin', 'codex'),
    join(home, '.local', 'bin', 'codex'),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? 'codex'
}

/** one bounded app-server session; it never creates a conversation or model turn */
export function readCodexWeeklyUsage(options: { now?: number; timeoutMs?: number; signal?: AbortSignal; binary?: string } = {}): Promise<CodexUsageReading> {
  const sampledAt = options.now ?? Date.now() / 1000
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary ?? codexBinaryPath(), ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let settled = false
    const abort = () => finish(new Error('Codex usage reader stopped'))
    const finish = (error?: Error, reading?: CodexUsageReading) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(reading!)
    }
    const timer = setTimeout(() => finish(new Error('Codex usage request timed out')), timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) return abort()
    child.on('error', (error) => finish(new Error(`could not start Codex: ${error.message}`)))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Codex exited before reporting usage (${code ?? 'signal'})`))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n')
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: { id?: number; result?: unknown; error?: { message?: string } }
        try { message = JSON.parse(line) as typeof message } catch { continue }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message ?? 'Codex initialization failed'))
          send(child, { method: 'initialized' })
          send(child, { id: 2, method: 'account/rateLimits/read' })
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message ?? 'Codex usage request failed'))
          const reading = selectCodexWeeklyWindow(message.result as RateLimitsResponse, sampledAt)
          finish(reading ? undefined : new Error('Codex did not report a weekly allowance'), reading ?? undefined)
        }
      }
    })
    send(child, {
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'tally', title: 'Tally', version: '0.1.0' }, capabilities: { experimentalApi: true } },
    })
  })
}

export interface CodexUsageReader {
  refresh(): Promise<void>
  stop(): void
}

/** starts an immediate read and then refreshes without overlapping requests */
export function startCodexUsageReader(options: { paths?: CodexUsagePaths; intervalMs?: number; onUpdate?: () => void | Promise<void> } = {}): CodexUsageReader {
  const paths = options.paths ?? codexUsagePaths()
  let stopped = false
  let running = false
  let active: AbortController | null = null
  const refresh = async () => {
    if (stopped || running) return
    running = true
    active = new AbortController()
    const checkedAt = Date.now() / 1000
    try {
      recordCodexReading(paths, await readCodexWeeklyUsage({ now: checkedAt, signal: active.signal }))
    } catch (error) {
      if (!stopped) {
        recordCodexFailure(paths, checkedAt, error instanceof Error ? error.message : String(error))
        console.error(`tally: Codex usage read failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      active = null
      running = false
    }
    if (!stopped) {
      try {
        await options.onUpdate?.()
      } catch (error) {
        console.error(`tally: Codex usage update failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  void refresh()
  const interval = setInterval(refresh, options.intervalMs ?? 5 * 60_000)
  interval.unref()
  return { refresh, stop: () => { stopped = true; clearInterval(interval); active?.abort() } }
}
