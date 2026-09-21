// reads Codex's account-level weekly allowance and keeps a small local history.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { median } from './split'
import { dayBounds, dayKey, isWeekend, weekdayName } from './time'

export const CODEX_WEEK_MINUTES = 7 * 24 * 60
export const CODEX_STALE_SECONDS = 15 * 60
/** a day counts as fully read only with a reading this close to both of its midnights */
export const CODEX_DAY_EDGE_SECONDS = 3 * 3600
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
 * the weekly verdict, counted in workdays: weekends are free, and every Prague
 * weekday left before the reset is expected to burn a typical day. the typical
 * day is the median of this window's fully read weekdays; before one exists it
 * is today so far, and the verdict says it is provisional.
 */
export interface CodexPace {
  ready: boolean
  /** true while the typical day is today so far rather than measured full days */
  provisional: boolean
  /** why there is no projection, null when there is one */
  reason: string | null
  /** points a workday is expected to burn */
  typicalDay: number | null
  /** how many full weekdays the typical day is the median of; 0 when provisional */
  measuredDays: number
  /** where the meter lands at the reset if every workday burns the typical day */
  pctAtReset: number | null
  /** when that reaches 100, null if it does not before the reset */
  hitsHundredAt: number | null
  /** the expected meter from the latest reading to the reset, flat across weekends */
  path: { t: number; pct: number }[]
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
  /** `absent` is "no codex on this machine" and hides Codex; `unavailable` is a read that failed */
  status: 'fresh' | 'stale' | 'unavailable' | 'absent'
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

/** the reading closest before `t` within the day edge, or null */
function readingBefore(window: CodexUsageReading[], t: number): CodexUsageReading | null {
  const found = window.filter((reading) => reading.sampledAt <= t).at(-1)
  return found && t - found.sampledAt <= CODEX_DAY_EDGE_SECONDS ? found : null
}

/** the reading closest after `t` within the day edge, or null */
function readingAfter(window: CodexUsageReading[], t: number): CodexUsageReading | null {
  const found = window.find((reading) => reading.sampledAt >= t)
  return found && found.sampledAt - t <= CODEX_DAY_EDGE_SECONDS ? found : null
}

/** points each fully read weekday burned, skipping the day the window opened in and today */
export function codexWorkdayDeltas(window: CodexUsageReading[]): number[] {
  const latest = window.at(-1)
  if (!latest) return []
  const windowStart = latest.resetsAt - latest.windowDurationMins * 60
  const [todayStart] = dayBounds(latest.sampledAt)
  const deltas: number[] = []
  for (let cursor = dayBounds(windowStart)[1]; cursor < todayStart; cursor = dayBounds(cursor)[1]) {
    const [start, end] = dayBounds(cursor)
    if (isWeekend(start)) continue
    const before = readingBefore(window, start)
    const after = readingAfter(window, end)
    if (before && after) deltas.push(Math.max(0, after.usedPercent - before.usedPercent))
  }
  return deltas
}

/** projects the week in workdays, or says why it cannot yet */
export function codexPace(window: CodexUsageReading[]): CodexPace | null {
  const latest = window.at(-1)
  if (!latest) return null
  const used = latest.usedPercent
  const now = latest.sampledAt
  const windowStart = latest.resetsAt - latest.windowDurationMins * 60
  const base = { typicalDay: null, measuredDays: 0, pctAtReset: null, hitsHundredAt: null, path: [] }
  const waiting = (reason: string): CodexPace => ({ ready: false, provisional: false, reason, ...base, phrase: 'no pace yet' })
  if (used >= 100) {
    return { ready: true, provisional: false, reason: null, ...base, pctAtReset: 100, hitsHundredAt: now, phrase: 'at 100%' }
  }
  // the workday model assumes the meter only climbs inside a window; a drop means it was reset early
  if (used < Math.max(...window.map((reading) => reading.usedPercent))) return waiting('the meter went down inside this week')

  const [todayStart, todayEnd] = dayBounds(now)
  const todayIsWorkday = !isWeekend(todayStart)
  const midnight = windowStart >= todayStart ? null : readingBefore(window, todayStart)
  // null when the reader missed the start of today, so today's burn is unknown
  const todaySoFar = windowStart >= todayStart ? used : midnight ? used - midnight.usedPercent : null

  const deltas = codexWorkdayDeltas(window)
  const provisional = deltas.length === 0
  let typicalDay: number
  if (!provisional) {
    typicalDay = median(deltas)!
  } else {
    if (!todayIsWorkday) return waiting('no workday read yet this week')
    if (todaySoFar === null) return waiting('the reader missed the start of today')
    if (todaySoFar <= 0) return waiting('nothing used yet today')
    typicalDay = todaySoFar
  }

  const path = [{ t: now, pct: used }]
  let level = used
  const crossing: { at: number | null } = { at: null }
  const advance = (from: number, to: number, points: number) => {
    if (crossing.at === null && points > 0 && level + points >= 100) {
      crossing.at = from + ((100 - level) / points) * (to - from)
    }
    level += points
    path.push({ t: to, pct: Math.min(100, level) })
  }
  // provisional means today is the typical day, so today is already spent; otherwise the rest of a typical day is still to come
  const restOfToday = provisional || !todayIsWorkday ? 0 : Math.max(0, typicalDay - (todaySoFar ?? 0))
  advance(now, Math.min(todayEnd, latest.resetsAt), restOfToday)
  for (let cursor = todayEnd; cursor < latest.resetsAt; cursor = dayBounds(cursor)[1]) {
    const [start, end] = dayBounds(cursor)
    const stop = Math.min(end, latest.resetsAt)
    // the reset day counts for the part of it before the reset
    advance(start, stop, isWeekend(start) ? 0 : typicalDay * ((stop - start) / (end - start)))
  }

  const pctAtReset = Math.min(100, level)
  const suffix = provisional ? ', provisional' : ''
  const hits = crossing.at
  const phrase =
    hits === null
      ? `≈ ${Math.round(pctAtReset)}% at reset${suffix}`
      : `100% ${hits < todayEnd ? 'today' : `by ${weekdayName(hits)}`}${suffix}`
  return { ready: true, provisional, reason: null, typicalDay, measuredDays: deltas.length, pctAtReset, hitsHundredAt: hits, path, phrase }
}

export interface CodexUsageViewOptions {
  /** false when no codex binary was found; the view is `absent` and the page drops Codex */
  installed?: boolean
  /**
   * freeze the view at this instant: readings taken after it did not exist yet,
   * so the window, the pace and the percentage are the ones `at` would have seen.
   * the reader's own status file describes right now and is ignored when set.
   */
  at?: number
}

/** gives both glance surfaces and the page one canonical, honest reading */
export function codexUsageView(paths: CodexUsagePaths, now: number, options: CodexUsageViewOptions = {}): CodexUsageView {
  const at = options.at ?? null
  if (options.installed === false) {
    // a leftover reading from a machine that has since lost Codex would be a
    // number nothing can refresh, so `absent` reports nothing at all
    return { status: 'absent', line: 'Codex · not installed', usedPercent: null, resetsAt: null, sampledAt: null, ageSeconds: null, windowStart: null, pace: null, history: [] }
  }
  const status = readJson<CodexReadStatus>(paths.status)
  const all = readCodexHistory(paths.history)
  const readings = at === null ? all : all.filter((reading) => reading.sampledAt <= at)
  const latest = readings.at(-1) ?? null
  const empty = { windowStart: null, pace: null, history: [] }
  if (!latest || (!status && at === null)) {
    // frozen before the reader's first row: the meter was not being read yet
    const first = all[0]
    const line = at !== null && first && first.sampledAt > at ? `Codex · no reading yet, the reader started ${dayKey(first.sampledAt)}` : 'Codex · unavailable'
    return { status: 'unavailable', line, usedPercent: null, resetsAt: null, sampledAt: null, ageSeconds: null, ...empty }
  }
  const ageSeconds = Math.max(0, now - latest.sampledAt)
  if (latest.resetsAt <= now) {
    return { status: 'unavailable', line: 'Codex · awaiting new weekly reading', usedPercent: null, resetsAt: null, sampledAt: latest.sampledAt, ageSeconds, ...empty }
  }
  const window = currentWindowReadings(readings)
  const windowStart = latest.resetsAt - latest.windowDurationMins * 60
  const history = thinHistory(window)
  // the reader's status describes right now, so a frozen view is judged on the
  // age of the reading it froze on and nothing else
  const readerStale = !status?.ok || now - (status?.checkedAt ?? 0) > CODEX_STALE_SECONDS
  if (ageSeconds > CODEX_STALE_SECONDS || (at === null && readerStale)) {
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

/** finds Codex in the service's PATH or common user-level install locations; null when the machine has none */
export function codexBinaryPath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.CODEX_BIN,
    ...(env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'codex')),
    join(home, '.bun', 'bin', 'codex'),
    join(home, '.local', 'bin', 'codex'),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null
}

/** one bounded app-server session; it never creates a conversation or model turn */
export function readCodexWeeklyUsage(options: { now?: number; timeoutMs?: number; signal?: AbortSignal; binary?: string } = {}): Promise<CodexUsageReading> {
  const sampledAt = options.now ?? Date.now() / 1000
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const binary = options.binary ?? codexBinaryPath()
  return new Promise((resolve, reject) => {
    // nothing to spawn: a machine with no Codex has no reading, not a failed one
    if (!binary) return reject(new Error('no codex binary on this machine'))
    const child = spawn(binary, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
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
export function startCodexUsageReader(options: { paths?: CodexUsagePaths; intervalMs?: number; binary?: string | null; onUpdate?: () => void | Promise<void> } = {}): CodexUsageReader {
  const paths = options.paths ?? codexUsagePaths()
  const binary = options.binary === undefined ? codexBinaryPath() : options.binary
  if (!binary) {
    // without a binary every read would be a failed spawn on a timer, and the
    // failures would be written down as if Codex were broken rather than absent
    console.log('tally: no codex binary found, so the Codex meter is off')
    return { refresh: async () => {}, stop: () => {} }
  }
  let stopped = false
  let running = false
  let active: AbortController | null = null
  const refresh = async () => {
    if (stopped || running) return
    running = true
    active = new AbortController()
    const checkedAt = Date.now() / 1000
    try {
      recordCodexReading(paths, await readCodexWeeklyUsage({ now: checkedAt, signal: active.signal, binary }))
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
