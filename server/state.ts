// everything the page draws, assembled once per request.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dayLanes, DEFAULT_CCBROWSE, type Lane } from './ccbrowse'
import {
  blocks as groupBlocks,
  currentBlock,
  limitsLogPath,
  readSamples,
  type Sample,
} from './samples'
import {
  CAVEAT,
  dailyDeltas,
  project,
  splitBlock,
  weeklyVerdict,
  type BlockSplit,
  type SessionSplit,
  type WeeklyVerdict,
} from './split'
import { otherThreads, statePath, type Thread } from './t3'
import { dayBounds } from './time'
import { projectsRoot, scan } from './transcripts'

/** the strip and the list share these, in rank order, so the two always match */
export const PALETTE = ['#d94f2a', '#b5836a', '#8f8a82', '#a9a49b', '#c2bdb4', '#cfcac1', '#dcd8d0']
export const OTHER_COLOR = '#3c6e9e'

/** a lead transcript written this recently is a session that is still running */
const LIVE_WINDOW = 120

export interface Options {
  home?: string
  ccbrowse?: string | null
  now?: number
  /** file that remembers when the page was last opened */
  lastLookedPath?: string
  /** false while assembling a state for a test */
  recordLook?: boolean
}

export interface MeterView {
  pct: number
  resetsAt: number | null
  verdict: WeeklyVerdict | null
}

export interface SessionRow extends SessionSplit {
  kind: 'claude'
  live: boolean
  color: string
}

export interface OtherRow extends Thread {
  color: string
}

export interface State {
  now: number
  lastLooked: number | null
  caveat: string
  fiveHour: {
    pct: number
    resetsAt: number
    sampledAt: number
    ageSeconds: number
    /** the newest block's reset has already passed: the sampler is behind */
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
    projection: { pctAtReset: number; hitsHundredAt: number | null; pace: number }
  } | null
  split: (Omit<BlockSplit, 'sessions'> & { sessions: SessionRow[] }) | null
  others: OtherRow[]
  day: {
    start: number
    end: number
    meter: { t: number; pct: number; resetKey: number; weeklyPct: number | null; scopedPct: number | null }[]
    lanes: Lane[]
    lanesError: string | null
  }
  sources: {
    limits: string
    transcripts: string
    t3: string
    ccbrowse: string | null
  }
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
  const now = options.now ?? Date.now() / 1000
  const ccbrowseBase = options.ccbrowse === undefined ? DEFAULT_CCBROWSE : options.ccbrowse
  const lookPath = options.lastLookedPath ?? lastLookedFile(home)
  const lastLooked = readLastLooked(lookPath)
  if (options.recordLook !== false) writeLastLooked(lookPath, now)

  const samples = readSamples(limitsLogPath(home))
  const all = groupBlocks(samples)
  const current = currentBlock(all, now)
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

  let block: State['block'] = null
  let split: State['split'] = null
  if (current) {
    const from = current.first.t
    const to = current.last.t
    const { records, sessions } = await scan(current.block.start, now, projectsRoot(home))
    // no delta to divide means no points at all, per the proof
    const delta = to > from ? current.delta : null
    const raw = splitBlock(records, sessions, { from, to, delta, blockStart: current.block.start })
    split = {
      ...raw,
      sessions: raw.sessions.map((row, index) => ({
        ...row,
        kind: 'claude' as const,
        live: now - (sessions.get(row.sessionId)?.modified ?? 0) < LIVE_WINDOW,
        color: PALETTE[Math.min(index, PALETTE.length - 1)]!,
      })),
    }
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

  const lanes = ccbrowseBase
    ? await dayLanes(dayStart, dayEnd, ccbrowseBase)
    : { lanes: [], error: 'cc-browse lookup is turned off (--no-ccbrowse)' }

  const others = otherThreads(block?.start ?? dayStart, now, statePath(home)).map((thread) => ({
    ...thread,
    color: OTHER_COLOR,
  }))

  return {
    now,
    lastLooked,
    caveat: CAVEAT,
    fiveHour: current
      ? {
          pct: current.last.pct,
          resetsAt: current.block.resetKey,
          sampledAt: current.last.t,
          ageSeconds: current.sampleAge,
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
      lanes: lanes.lanes,
      lanesError: lanes.error,
    },
    sources: {
      limits: limitsLogPath(home),
      transcripts: projectsRoot(home),
      t3: statePath(home),
      ccbrowse: ccbrowseBase,
    },
  }
}
