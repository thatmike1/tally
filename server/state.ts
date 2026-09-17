// everything the page draws, assembled once per request.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { codexSessionsRoot, scanRollouts, splitCodexWeek, t3CodexThreads, type CodexWeekSplit } from './codex-sessions'
import { codexUsagePaths, codexUsageView, type CodexUsageView } from './codex-usage'
import type { IndexProgress, Lane } from './history-types'
import { buildLanes, LIVE_WINDOW } from './lanes'
import {
  blocks as groupBlocks,
  currentBlock,
  FIVE_HOURS,
  limitsLogPath,
  readLog,
  type Sample,
} from './samples'
import {
  CAVEAT,
  dailyDeltas,
  openedAtZero,
  project,
  scopedReadings,
  splitBlock,
  splitFable,
  splitWeekly,
  WEEK,
  WEEK_CAVEAT,
  weeklyReadings,
  weeklyVerdict,
  weekWindow,
  type BlockSplit,
  type Projection,
  type SessionSplit,
  type WeeklyVerdict,
  type WeekWindow,
  type WindowSplit,
} from './split'
import { otherThreads, statePath, type Thread } from './t3'
import { dayBounds, formatLocalTime } from './time'
import { indexPath, type TranscriptIndex } from './transcript-index'
import { projectsRoot, scan, type RequestRecord, type SessionMeta } from './transcripts'

/** the strip and the list share these, in rank order, so the two always match */
export const PALETTE = ['#d94f2a', '#b5836a', '#8f8a82', '#a9a49b', '#c2bdb4', '#cfcac1', '#dcd8d0']
export const OTHER_COLOR = '#3c6e9e'

export interface Options {
  home?: string
  now?: number
  /** the transcript index; without one every window is read with a live `scan()` */
  index?: TranscriptIndex | null
  /** file that remembers when the page was last opened */
  lastLookedPath?: string
  /** false while assembling a state for a test */
  recordLook?: boolean
  codexPaths?: { history: string; status: string }
  /** `whole` splits the weekly meters over the full week since their reset, not since the last look */
  weekMode?: 'recent' | 'whole'
  /** `~/.codex/sessions` unless a test points elsewhere */
  codexSessions?: string
  /**
   * freeze the page at this instant (unix seconds): samples and requests after
   * it are ignored, `now` is `at`, and the "last looked" marker is neither read
   * nor written, because a frozen page is a drill-in, not a look.
   */
  at?: number
}

export interface MeterView {
  pct: number
  resetsAt: number | null
  verdict: WeeklyVerdict | null
}

export interface SessionRow extends SessionSplit {
  kind: 'claude'
  live: boolean
  /** by rank within its section, so a section's strips and list always match */
  color: string
  /** this session's share of the Fable meter's movement over the week window; null when there is no Fable split */
  fableShare: number | null
  fablePoints: number | null
}

export type WeekSplit = Omit<WindowSplit, 'sessions'> & { sessions: SessionRow[] }

export interface OtherRow extends Thread {
  color: string
}

export interface State {
  now: number
  /** how far the transcript index has got; the page says so while it builds */
  index: IndexProgress
  lastLooked: number | null
  codex: CodexUsageView & {
    /** which Codex threads moved the weekly meter since the window opened */
    split: CodexWeekSplit | null
  }
  caveat: string
  fiveHour: {
    pct: number
    resetsAt: number
    sampledAt: number
    ageSeconds: number
    /** the block's reset has passed; `pct` is 0 and `resetsAt` is when it reset */
    ended: boolean
    /** when a block opened by a message right now would reset; null while a block runs */
    nextResetsAt: number | null
    /** the block ended a while ago and nothing has read the account since: the sampler is behind */
    expired: boolean
    saturated: boolean
    maxGap: number
  } | null
  weekly: MeterView | null
  fable: (MeterView & { model: string }) | null
  extra: Sample['extra']
  /** unmodelled payload fields, shown as a small note and never computed on */
  notes: string[]
  block: {
    start: number
    resetsAt: number
    from: number
    to: number
    startPct: number
    endPct: number
    delta: number | null
    samples: { t: number; pct: number }[]
    projection: Projection
  } | null
  split: (Omit<BlockSplit, 'sessions'> & { sessions: SessionRow[] }) | null
  /** which sessions moved the weekly and Fable meters, since the last look or since midnight */
  week: {
    /** the window asked for; each split snaps inside it to the samples it has */
    from: number
    to: number
    since: 'lastLooked' | 'today' | 'week'
    lastLooked: number | null
    caveat: string
    weekly: WeekSplit | null
    fable: WeekSplit | null
  }
  others: OtherRow[]
  day: {
    start: number
    end: number
    meter: { t: number; pct: number; resetKey: number; weeklyPct: number | null; scopedPct: number | null }[]
    lanes: Lane[]
  }
  sources: {
    limits: string
    transcripts: string
    t3: string
    index: string
  }
}

/**
 * a block runs five hours from the message that opens it, with the start on a
 * ten-minute mark: a first sample at 13:15 read a reset of 18:10
 */
export function nextReset(now: number): number {
  return Math.floor(now / 600) * 600 + FIVE_HOURS
}

function lastLookedFile(home: string): string {
  return join(home, '.cache', 'tally', 'last-looked')
}

function readLastLooked(path: string): number | null {
  try {
    const value = Number(readFileSync(path, 'utf8').trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function writeLastLooked(path: string, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(Math.round(now)))
  } catch {
    // a missing marker only costs the dashed line on the chart
  }
}

export async function buildState(options: Options = {}): Promise<State> {
  const home = options.home ?? homedir()
  const now = options.at ?? options.now ?? Date.now() / 1000
  const index = options.index ?? null
  const lookPath = options.lastLookedPath ?? lastLookedFile(home)
  // a page frozen at a past instant has no "since you last looked" to draw
  const frozen = options.at !== undefined
  const lastLooked = frozen ? null : readLastLooked(lookPath)
  // frozen, the Codex meter is the reading `at` would have seen: the window
  // containing it, no reading after it, and the rollouts cut at the same instant
  const codexView = codexUsageView(options.codexPaths ?? codexUsagePaths(home), now, frozen ? { at: now } : {})
  let codexSplit: CodexWeekSplit | null = null
  if (codexView.windowStart !== null && codexView.resetsAt !== null) {
    const rollouts = await scanRollouts(codexView.windowStart, options.codexSessions ?? codexSessionsRoot(home), frozen ? now : undefined)
    const anchor = codexView.status === 'fresh' && codexView.sampledAt !== null && codexView.usedPercent !== null
      ? { t: codexView.sampledAt, pct: codexView.usedPercent }
      : null
    codexSplit = splitCodexWeek(rollouts, { from: codexView.windowStart, resetsAt: codexView.resetsAt }, anchor, t3CodexThreads(statePath(home)), now)
  }
  const codex = { ...codexView, split: codexSplit }
  if (options.recordLook !== false && !frozen) writeLastLooked(lookPath, now)

  const log = readLog(limitsLogPath(home))
  // frozen: only what the sampler had read by `at` exists. `readLog` reports the
  // newest reading of the whole log, block or no block, so past `at` it falls
  // back to the newest sample, which can date a frozen page a few minutes early
  const samples = frozen ? log.samples.filter((s) => s.t <= now) : log.samples
  const lastRead = frozen
    ? log.lastRead !== null && log.lastRead <= now
      ? log.lastRead
      : (samples.at(-1)?.t ?? null)
    : log.lastRead
  const all = groupBlocks(samples)
  const current = currentBlock(all, now, lastRead)
  const [dayStart, dayEnd] = dayBounds(now)

  const weekdayWeekly = dailyDeltas(samples, (s) => s.weeklyPct)
    .filter((d) => !d.weekend)
    .slice(-6)
    .map((d) => d.delta)
  const fableName = samples.at(-1)?.scoped[0]?.model ?? null
  const weekdayFable = fableName
    ? dailyDeltas(samples, (s) => s.scoped.find((m) => m.model === fableName)?.pct ?? null)
        .filter((d) => !d.weekend)
        .slice(-6)
        .map((d) => d.delta)
    : []

  const latest = samples.at(-1) ?? null
  const weekly: MeterView | null =
    latest && latest.weeklyPct !== null
      ? {
          pct: latest.weeklyPct,
          resetsAt: latest.weeklyResetsAt,
          verdict: weeklyVerdict(latest.weeklyPct, latest.weeklyResetsAt, now, weekdayWeekly, null),
        }
      : null
  const scoped = latest?.scoped[0] ?? null
  const fable = scoped
    ? {
        model: scoped.model,
        pct: scoped.pct,
        resetsAt: scoped.resetsAt,
        verdict: weeklyVerdict(scoped.pct, scoped.resetsAt, now, weekdayFable, scoped.model),
      }
    : null

  const notes: string[] = []
  for (const key of Object.keys(latest?.unknown ?? {})) notes.push(`sample carries an extra field: ${key}`)
  for (const entry of latest?.otherLimits ?? []) {
    if (typeof entry === 'object' && entry !== null) {
      const { kind, percent, resets_at } = entry as Record<string, unknown>
      // the five-hour and weekly meters again under their newer names; the hero already shows both
      if (kind === 'session' || kind === 'weekly_all') continue
      if (kind && percent !== undefined) {
        const time = formatLocalTime(resets_at)
        notes.push(time ? `limit: ${kind} ${percent}% resets ${time}` : `limit: ${kind} ${percent}%`)
        continue
      }
    }
    notes.push(JSON.stringify(entry))
  }

  const weeklyRows = weeklyReadings(samples)
  const weekStart = latest?.weeklyResetsAt ? latest.weeklyResetsAt - WEEK : null
  const window: WeekWindow =
    options.weekMode === 'whole' && weekStart !== null
      ? { from: Math.max(weekStart, 0), to: now, since: 'week' }
      : weekWindow(now, lastLooked, latest?.weeklyResetsAt ?? null, weeklyRows, dayStart)
  // the lanes cover the whole day, so the read starts at whichever of the three
  // windows opens first
  const scanStart = Math.min(window.from, current?.block.start ?? window.from, dayStart)
  let records: RequestRecord[]
  let sessions: Map<string, SessionMeta>
  if (index && index.covers(scanStart)) {
    ;({ records, sessions } = index.query(scanStart, now))
  } else {
    // the index has not reached this far back yet: read the tree, as v1 did
    ;({ records, sessions } = await scan(scanStart, now, projectsRoot(home)))
  }

  const whole = window.since === 'week'
  const fableRows = fableName ? scopedReadings(samples, fableName) : []
  const rawWeekly = splitWeekly(records, sessions, whole ? openedAtZero(weeklyRows, latest?.weeklyResetsAt ?? null) : weeklyRows, window)
  const rawFable = fableName
    ? splitFable(records, sessions, whole ? openedAtZero(fableRows, fableRows.at(-1)?.resetsAt ?? null) : fableRows, window)
    : null
  const fableById = new Map((rawFable?.sessions ?? []).map((row) => [row.sessionId, row]))

  // the week section ranks by Fable share, then weekly share, so the top Fable
  // mover takes the first colour and both week strips agree with its list
  const weekRank = new Map<string, number>()
  for (const row of [...(rawFable?.sessions ?? []), ...(rawWeekly?.sessions ?? [])]) {
    if (!weekRank.has(row.sessionId)) weekRank.set(row.sessionId, weekRank.size)
  }
  const toRow = (row: SessionSplit, rank: number): SessionRow => {
    const fableRow = fableById.get(row.sessionId)
    return {
      ...row,
      kind: 'claude',
      live: now - (sessions.get(row.sessionId)?.modified ?? 0) < LIVE_WINDOW,
      color: PALETTE[Math.min(rank, PALETTE.length - 1)]!,
      fableShare: rawFable && !rawFable.crossedReset ? (fableRow?.share ?? 0) : null,
      fablePoints: fableRow?.points ?? null,
    }
  }
  const withRows = (raw: WindowSplit | null): WeekSplit | null =>
    raw ? { ...raw, sessions: raw.sessions.map((row) => toRow(row, weekRank.get(row.sessionId)!)) } : null

  let block: State['block'] = null
  let split: State['split'] = null
  if (current) {
    const from = current.first.t
    const to = current.last.t
    // no delta to divide means no points at all, per the proof
    const delta = to > from ? current.delta : null
    const raw = splitBlock(records, sessions, {
      from,
      to,
      delta,
      blockStart: current.block.start,
      blockEnd: current.block.resetKey,
    })
    split = { ...raw, sessions: raw.sessions.map(toRow) }
    block = {
      start: current.block.start,
      resetsAt: current.block.resetKey,
      from,
      to,
      startPct: current.first.pct,
      endPct: current.last.pct,
      delta,
      samples: current.samples.map((s) => ({ t: s.t, pct: s.pct })),
      projection: project(current.first, current.last, current.block.resetKey),
    }
  }

  const threads = otherThreads(dayStart, dayEnd, statePath(home))
  const lanes = buildLanes({ records, sessions, threads, from: dayStart, to: dayEnd, now })

  // Codex threads have their own list under the Codex meter, with real shares on them
  const others = otherThreads(block?.start ?? dayStart, now, statePath(home))
    .filter((thread) => thread.kind !== 'codex')
    .map((thread) => ({
    ...thread,
    color: OTHER_COLOR,
  }))

  return {
    now,
    index: index?.progress() ?? { building: false, done: 0, total: 0, builtAt: null, cold: true, failed: 0 },
    lastLooked,
    codex,
    caveat: CAVEAT,
    fiveHour: current
      ? {
          pct: current.ended ? 0 : current.last.pct,
          resetsAt: current.block.resetKey,
          sampledAt: current.last.t,
          ageSeconds: current.sampleAge,
          ended: current.ended,
          nextResetsAt: current.ended ? nextReset(now) : null,
          expired: current.expired,
          saturated: current.saturated,
          maxGap: current.maxGap,
        }
      : null,
    weekly,
    fable,
    extra: latest?.extra ?? null,
    notes,
    block,
    split,
    week: {
      ...window,
      lastLooked,
      caveat: WEEK_CAVEAT,
      weekly: withRows(rawWeekly),
      fable: withRows(rawFable),
    },
    others,
    day: {
      start: dayStart,
      end: dayEnd,
      meter: samples
        .filter((s) => s.t >= dayStart && s.t < dayEnd)
        .map((s) => ({
          t: s.t,
          pct: s.pct,
          resetKey: s.resetKey,
          weeklyPct: s.weeklyPct,
          scopedPct: fableName ? (s.scoped.find((m) => m.model === fableName)?.pct ?? null) : null,
        })),
      lanes,
    },
    sources: {
      limits: limitsLogPath(home),
      transcripts: projectsRoot(home),
      t3: statePath(home),
      index: index?.path ?? indexPath(home),
    },
  }
}
