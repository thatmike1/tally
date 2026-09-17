// which Codex threads moved the Codex weekly meter, off Codex's own rollout files.
//
// every model call writes a `token_usage_record` (tokens, a response id) and a
// `token_count` event carrying the account's rate-limit reading at that call.
// the meter is cumulative since the window opened, so the window's movement is
// the latest reading, and it is split across threads by credits, priced from
// OpenAI's Codex rate card. subagent rollouts fold into their root thread; a
// forked subagent copies its parent's history, so calls are deduplicated on the
// response id and kept only in the file of the thread that made them.
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { CODEX_WEEK_MINUTES } from './codex-usage'

/** credits per million tokens, from https://help.openai.com/en/articles/20001106-codex-rate-card (read 15 Sep 2026) */
export const CODEX_RATES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6-astra': { input: 250, cached: 25, output: 1250 },
  'gpt-5.6-sol': { input: 100, cached: 10, output: 500 },
  'gpt-5.6-terra': { input: 50, cached: 5, output: 300 },
  'gpt-5.6-luna': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.5': { input: 125, cached: 12.5, output: 750 },
  'gpt-5.4': { input: 62.5, cached: 6.25, output: 375 },
  'gpt-5.4-mini': { input: 18.75, cached: 1.875, output: 113 },
  'gpt-5.3-codex': { input: 43.75, cached: 4.375, output: 350 },
  'gpt-5.2': { input: 43.75, cached: 4.375, output: 350 },
}

/** an unknown model is priced like Sol and flagged, so it still gets a row */
const FALLBACK_RATE = CODEX_RATES['gpt-5.6-sol']!

export interface CodexCall {
  t: number
  responseId: string
  model: string
  /** uncached input */
  input: number
  cached: number
  output: number
  credits: number
  priced: boolean
}

export interface CodexReadingPoint {
  t: number
  pct: number
  resetsAt: number
}

export interface CodexRollout {
  path: string
  /** this rollout's own thread */
  id: string
  /** the thread a subagent was spawned under; its own id otherwise */
  rootId: string
  subagent: boolean
  /** `t3code_desktop`, `codex_exec`, `codex_cli_rs` … */
  originator: string | null
  cwd: string | null
  /** false for a thread routed to another provider, which never touches the Codex meter */
  openai: boolean
  firstPrompt: string | null
  calls: CodexCall[]
  readings: CodexReadingPoint[]
  /** last timestamp in the file */
  lastT: number | null
}

/** `GPT-5.6 Sol`, `gpt-5.6-sol` and `gpt-5.6-sol-2026-08` all price as `gpt-5.6-sol` */
export function codexRate(model: string): { rate: (typeof CODEX_RATES)[string]; priced: boolean } {
  const key = model.toLowerCase().trim().replace(/\s+/g, '-')
  const exact = CODEX_RATES[key]
  if (exact) return { rate: exact, priced: true }
  const prefix = Object.keys(CODEX_RATES)
    .sort((a, b) => b.length - a.length)
    .find((name) => key.startsWith(`${name}-`))
  return prefix ? { rate: CODEX_RATES[prefix]!, priced: true } : { rate: FALLBACK_RATE, priced: false }
}

/** credits for one call; `input` here already excludes the cached part */
export function codexCredits(model: string, input: number, cached: number, output: number): { credits: number; priced: boolean } {
  const { rate, priced } = codexRate(model)
  return { credits: (input * rate.input + cached * rate.cached + output * rate.output) / 1_000_000, priced }
}

function seconds(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms / 1000
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** a user message Codex injected (instructions, environment) rather than one typed by a person */
function injected(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('<') || trimmed.startsWith('#')
}

/** parses one rollout's lines; exported for tests, `scanRollouts` streams files into it */
export function parseRolloutLines(path: string, lines: Iterable<string>): CodexRollout | null {
  let meta: CodexRollout | null = null
  let model = '?'
  const calls: CodexCall[] = []
  const readings: CodexReadingPoint[] = []
  let lastT: number | null = null
  for (const raw of lines) {
    if (!raw) continue
    // most lines are tool output and model text; skip parsing what cannot matter
    if (
      !raw.includes('"session_meta"') &&
      !raw.includes('"turn_context"') &&
      !raw.includes('"token_usage_record"') &&
      !raw.includes('"token_count"') &&
      !(meta && meta.firstPrompt === null && raw.includes('"role":"user"'))
    ) {
      continue
    }
    let line: Record<string, any>
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    const t = seconds(line.timestamp)
    if (t !== null) lastT = t
    const payload = line.payload ?? {}
    if (line.type === 'session_meta') {
      // a forked subagent can carry its parent's session_meta too; the first one is the file's own
      if (meta) continue
      const id = String(payload.id ?? '')
      if (!id) return null
      const parent = payload.parent_thread_id ?? payload.source?.subagent?.thread_spawn?.parent_thread_id ?? null
      meta = {
        path,
        id,
        rootId: String(payload.session_id ?? parent ?? id),
        subagent: parent !== null,
        originator: typeof payload.originator === 'string' ? payload.originator : null,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        openai: (payload.model_provider ?? 'openai') === 'openai',
        firstPrompt: null,
        calls,
        readings,
        lastT: null,
      }
    } else if (line.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model
    } else if (line.type === 'token_usage_record') {
      // copied parent history in a forked subagent belongs to the parent's file
      if (!meta || payload.thread_id !== meta.id || t === null) continue
      const usage = payload.usage ?? {}
      const cached = count(usage.cached_input_tokens)
      const input = Math.max(0, count(usage.input_tokens) - cached)
      const output = count(usage.output_tokens)
      const { credits, priced } = codexCredits(model, input, cached, output)
      calls.push({ t, responseId: String(payload.response_id ?? `${meta.id}:${line.ordinal}`), model, input, cached, output, credits, priced })
    } else if (line.type === 'event_msg' && payload.type === 'token_count') {
      const limits = payload.rate_limits
      if (t === null || !limits || (limits.limit_id && limits.limit_id !== 'codex')) continue
      for (const window of [limits.primary, limits.secondary]) {
        if (window?.window_minutes === CODEX_WEEK_MINUTES && typeof window.used_percent === 'number') {
          readings.push({ t, pct: window.used_percent, resetsAt: count(window.resets_at) })
        }
      }
    } else if (line.type === 'response_item' && payload.role === 'user' && meta && meta.firstPrompt === null) {
      const text = (payload.content ?? []).map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : '')).join(' ')
      if (text.trim() && !injected(text)) meta.firstPrompt = text.trim().replace(/\s+/g, ' ').slice(0, 140)
    }
  }
  if (!meta) return null
  meta.lastT = lastT
  return meta
}

export function codexSessionsRoot(home = homedir()): string {
  return join(home, '.codex', 'sessions')
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** every rollout under `~/.codex/sessions/YYYY/MM/DD/` */
export function rolloutFiles(root: string): { path: string; mtime: number; size: number }[] {
  const out: { path: string; mtime: number; size: number }[] = []
  for (const year of safeReaddir(root)) {
    for (const month of safeReaddir(join(root, year))) {
      for (const day of safeReaddir(join(root, year, month))) {
        const dir = join(root, year, month, day)
        for (const name of safeReaddir(dir)) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
          try {
            const stat = statSync(join(dir, name))
            out.push({ path: join(dir, name), mtime: stat.mtimeMs / 1000, size: stat.size })
          } catch {
            // a rollout removed between the listing and the stat
          }
        }
      }
    }
  }
  return out
}

const parsed = new Map<string, { mtime: number; size: number; rollout: CodexRollout | null }>()

async function parseFile(path: string): Promise<CodexRollout | null> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines: string[] = []
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) lines.push(line)
  } catch {
    return null
  }
  return parseRolloutLines(path, lines)
}

/**
 * rollouts written to since `since`; unchanged files come from memory.
 *
 * `until` freezes the scan at a past instant: calls, readings and the last
 * write after it have not happened yet. a file's mtime cannot make that cut,
 * so every rollout is trimmed line by line; the cache keeps the full parse.
 */
export async function scanRollouts(since: number, root = codexSessionsRoot(), until?: number): Promise<CodexRollout[]> {
  const out: CodexRollout[] = []
  for (const file of rolloutFiles(root)) {
    if (file.mtime < since) continue
    const cached = parsed.get(file.path)
    let rollout: CodexRollout | null
    if (cached && cached.mtime === file.mtime && cached.size === file.size) {
      rollout = cached.rollout
    } else {
      rollout = await parseFile(file.path)
      parsed.set(file.path, { mtime: file.mtime, size: file.size, rollout })
    }
    if (rollout) out.push(until === undefined ? rollout : cutRollout(rollout, until))
  }
  return out
}

/** the rollout as it stood at `until`: nothing written after it, last write no later than it */
export function cutRollout(rollout: CodexRollout, until: number): CodexRollout {
  if (rollout.lastT !== null && rollout.lastT <= until) return rollout
  const calls = rollout.calls.filter((call) => call.t <= until)
  const readings = rollout.readings.filter((reading) => reading.t <= until)
  // only calls and readings keep their timestamps; the last of those stands in
  // for the last line written by `until`
  const stamps = [...calls.map((call) => call.t), ...readings.map((reading) => reading.t)]
  return { ...rollout, calls, readings, lastT: stamps.length ? Math.max(...stamps) : null }
}

/** T3 thread titles keyed by the Codex thread id T3 resumes, plus whether a turn is in flight */
export function t3CodexThreads(path: string): Map<string, { title: string; live: boolean }> {
  const out = new Map<string, { title: string; live: boolean }>()
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return out
  }
  try {
    const rows = db
      .prepare(
        `SELECT t.title AS title, r.resume_cursor_json AS cursor, s.active_turn_id AS active
           FROM provider_session_runtime r
           JOIN projection_threads t ON t.thread_id = r.thread_id
           LEFT JOIN projection_thread_sessions s ON s.thread_id = r.thread_id
          WHERE r.provider_name = 'codex' AND t.deleted_at IS NULL`,
      )
      .all() as { title: unknown; cursor: unknown; active: unknown }[]
    for (const row of rows) {
      try {
        const threadId = JSON.parse(String(row.cursor ?? '{}')).threadId
        if (typeof threadId === 'string') {
          out.set(threadId, { title: String(row.title ?? 'untitled'), live: row.active !== null && row.active !== undefined })
        }
      } catch {
        // a runtime row without a resume cursor has not started a Codex thread
      }
    }
  } catch {
    // an older T3 schema without the runtime table: titles fall back to the first prompt
  } finally {
    db.close()
  }
  return out
}

export interface CodexThreadRow {
  /** the root Codex thread id; AgentsView knows it as `codex:<id>` */
  id: string
  title: string
  /** `t3`, `exec`, `cli` or the raw originator */
  via: string
  project: string | null
  credits: number
  /** fraction of the window's credits, 0..1 */
  share: number
  /** share x the meter's movement; null when nothing has been read */
  points: number | null
  calls: number
  subagents: number
  models: string[]
  unpriced: boolean
  start: number
  end: number
  live: boolean
  color: string
}

export interface CodexWeekSplit {
  from: number
  /** the reading the split is anchored on */
  to: number
  pct: number
  totalCredits: number
  /** credits the window spent per meter point, a calibration read off this week */
  creditsPerPoint: number | null
  /** credits between the first sightings of consecutive meter points: how steady a point is; null under three steps */
  pointSteps: { min: number; max: number; count: number } | null
  /** credits after the anchoring reading, not on the meter yet */
  pendingCredits: number
  threads: CodexThreadRow[]
}

/**
 * credits per meter point, step by step: each whole point's first sighting in any
 * rollout's readings, and the credits of the calls between one sighting and the next
 */
export function pointSteps(rollouts: CodexRollout[], window: { from: number; resetsAt: number }, to: number): CodexWeekSplit['pointSteps'] {
  const firstSeen = new Map<number, number>()
  const readings = rollouts
    .flatMap((rollout) => rollout.readings)
    .filter((reading) => reading.t >= window.from && reading.t <= to && Math.abs(reading.resetsAt - window.resetsAt) <= 120)
    .sort((a, b) => a.t - b.t)
  for (const reading of readings) {
    const level = Math.floor(reading.pct)
    if (!firstSeen.has(level)) firstSeen.set(level, reading.t)
  }
  const calls = new Map<string, CodexCall>()
  for (const rollout of rollouts) for (const call of rollout.calls) calls.set(call.responseId, call)
  const sorted = [...calls.values()].sort((a, b) => a.t - b.t)
  const levels = [...firstSeen.entries()].sort((a, b) => a[0] - b[0])
  const perPoint: number[] = []
  let previous: [number, number] = [0, window.from]
  for (const [level, t] of levels) {
    // a level seen earlier than the one below it came from a lagging rollout; skip it
    if (level <= previous[0] || t < previous[1]) continue
    const spent = sorted.filter((call) => call.t >= previous[1] && call.t < t).reduce((sum, call) => sum + call.credits, 0)
    perPoint.push(spent / (level - previous[0]))
    previous = [level, t]
  }
  if (perPoint.length < 3) return null
  return { min: Math.min(...perPoint), max: Math.max(...perPoint), count: perPoint.length }
}

/** blues for the Codex strip, darkest for the biggest share */
export const CODEX_PALETTE = ['#3c6e9e', '#5f88b1', '#7f9fc0', '#9db5cd', '#b6c7d9', '#cbd6e2']

/** a rollout written this recently belongs to a thread that is still running */
const LIVE_WINDOW = 120

function via(originator: string | null): string {
  if (originator === 't3code_desktop') return 't3'
  if (originator === 'codex_exec') return 'exec'
  if (originator === 'codex_cli_rs') return 'cli'
  return originator ?? 'codex'
}

/**
 * splits the window's meter movement across root threads by credits.
 *
 * `anchor` is the latest weekly reading of this window, from Tally's own reader
 * or from a rollout. calls between the window opening and that reading share its
 * percentage; calls after it are pending, since no reading covers them yet.
 */
export function splitCodexWeek(
  rollouts: CodexRollout[],
  window: { from: number; resetsAt: number },
  anchor: { t: number; pct: number } | null,
  t3: Map<string, { title: string; live: boolean }>,
  now: number,
): CodexWeekSplit | null {
  const openai = rollouts.filter((rollout) => rollout.openai)
  // the rollouts' own readings can be fresher than the reader's five-minute tick.
  // `now` is the cutoff, not just the clock: frozen at a past instant, a reading
  // or a call written after it has not happened yet and must not be counted.
  let latest = anchor
  for (const rollout of openai) {
    for (const reading of rollout.readings) {
      if (Math.abs(reading.resetsAt - window.resetsAt) > 120 || reading.t < window.from || reading.t > now) continue
      if (!latest || reading.t > latest.t) latest = { t: reading.t, pct: reading.pct }
    }
  }
  if (!latest) return null
  const to = latest.t

  const seen = new Set<string>()
  const byRoot = new Map<string, { credits: number; calls: number; agents: Set<string>; models: Set<string>; unpriced: boolean; start: number; end: number; lastWrite: number; lead: CodexRollout | null; any: CodexRollout }>()
  let totalCredits = 0
  let pendingCredits = 0
  for (const rollout of openai) {
    for (const call of rollout.calls) {
      if (call.t < window.from || call.t > now || seen.has(call.responseId)) continue
      seen.add(call.responseId)
      if (call.t > to) {
        pendingCredits += call.credits
        continue
      }
      let row = byRoot.get(rollout.rootId)
      if (!row) {
        row = { credits: 0, calls: 0, agents: new Set(), models: new Set(), unpriced: false, start: call.t, end: call.t, lastWrite: 0, lead: null, any: rollout }
        byRoot.set(rollout.rootId, row)
      }
      row.credits += call.credits
      row.calls += 1
      row.models.add(call.model)
      row.unpriced ||= !call.priced
      row.start = Math.min(row.start, call.t)
      row.end = Math.max(row.end, call.t)
      if (rollout.subagent) row.agents.add(rollout.id)
      totalCredits += call.credits
    }
  }
  for (const rollout of openai) {
    const row = byRoot.get(rollout.rootId)
    if (!row) continue
    // a rollout not cut at `now` can carry a later write; the row never does
    const lastT = rollout.lastT ?? 0
    row.lastWrite = Math.max(row.lastWrite, lastT <= now ? lastT : row.end)
    if (!rollout.subagent) row.lead = rollout
  }

  const threads = [...byRoot.entries()]
    .map(([id, row]): Omit<CodexThreadRow, 'color'> => {
      const lead = row.lead ?? row.any
      const share = totalCredits > 0 ? row.credits / totalCredits : 0
      const known = t3.get(id)
      const project = lead.cwd ? basename(lead.cwd) : null
      return {
        id,
        title: known?.title ?? lead.firstPrompt ?? `${project ?? 'codex'} · ${id.slice(0, 8)}`,
        via: via(lead.originator),
        project,
        credits: row.credits,
        share,
        points: latest.pct > 0 ? share * latest.pct : null,
        calls: row.calls,
        subagents: row.agents.size,
        models: [...row.models],
        unpriced: row.unpriced,
        start: row.start,
        end: row.end,
        live: known?.live ?? now - row.lastWrite < LIVE_WINDOW,
      }
    })
    .sort((a, b) => b.credits - a.credits)
    .map((row, rank) => ({ ...row, color: CODEX_PALETTE[Math.min(rank, CODEX_PALETTE.length - 1)]! }))

  return {
    from: window.from,
    to,
    pointSteps: pointSteps(openai, window, to),
    pct: latest.pct,
    totalCredits,
    creditsPerPoint: latest.pct > 0 && totalCredits > 0 ? totalCredits / latest.pct : null,
    pendingCredits,
    threads,
  }
}
