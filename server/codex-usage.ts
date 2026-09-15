// reads Codex's account-level weekly allowance and keeps a small local history.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CODEX_WEEK_MINUTES = 7 * 24 * 60
export const CODEX_STALE_SECONDS = 15 * 60
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

export interface CodexUsageView {
  status: 'fresh' | 'stale' | 'unavailable'
  line: string
  usedPercent: number | null
  resetsAt: number | null
  sampledAt: number | null
  ageSeconds: number | null
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

/** gives both glance surfaces one canonical, honest line */
export function codexUsageView(paths: CodexUsagePaths, now: number): CodexUsageView {
  const status = readJson<CodexReadStatus>(paths.status)
  const latest = readCodexHistory(paths.history).at(-1) ?? null
  if (!latest || !status) {
    return { status: 'unavailable', line: 'Codex · unavailable', usedPercent: null, resetsAt: null, sampledAt: null, ageSeconds: null }
  }
  const ageSeconds = Math.max(0, now - latest.sampledAt)
  if (latest.resetsAt <= now) {
    return { status: 'unavailable', line: 'Codex · awaiting new weekly reading', usedPercent: null, resetsAt: null, sampledAt: latest.sampledAt, ageSeconds }
  }
  if (!status.ok || now - status.checkedAt > CODEX_STALE_SECONDS || ageSeconds > CODEX_STALE_SECONDS) {
    return { status: 'stale', line: 'Codex · usage unavailable (last reading stale)', usedPercent: null, resetsAt: latest.resetsAt, sampledAt: latest.sampledAt, ageSeconds }
  }
  const rounded = Math.round(latest.usedPercent)
  return {
    status: 'fresh',
    line: `Codex · ${rounded}% used · resets in ${countdown(latest.resetsAt - now)}`,
    usedPercent: latest.usedPercent,
    resetsAt: latest.resetsAt,
    sampledAt: latest.sampledAt,
    ageSeconds,
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
