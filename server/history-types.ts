// the shared shapes behind the v4 history and detail routes. three workers build
// against this file at once (Claude history, Codex history, the ui), so it is
// the contract: change it only by agreement, never silently.
//
// every time is unix seconds, every money figure is usd at list price, every
// token count is raw. `null` always means "not measured" and the ui must say so
// rather than draw a zero.
import type { Family, Tokens } from './prices'
import type { Effort } from './transcripts'

/** cache read against uncached input, cache write against read; one small line per window */
export interface CacheRatio {
  /** cache-read tokens / (input + cache-write tokens); null when the denominator is 0 */
  readVsInput: number | null
  /** cache-write tokens / cache-read tokens; null when there were no reads */
  writeVsRead: number | null
}

export type CostByFamily = Partial<Record<Family, number>>

/** tokens and list cost over one window, as the transcript index reports them */
export interface WindowUsage {
  cost: number
  costByFamily: CostByFamily
  tokens: Tokens
  requests: number
  sessions: number
  /** true when at least one request in the window had no price row */
  unpriced: boolean
  cache: CacheRatio
}

/** one 5-hour block, as the overview strip and the meter-against-cost chart see it */
export interface BlockSummary {
  /** block identity: `round(resets_at / 60) * 60` */
  resetKey: number
  start: number
  /** first and last api sample inside the block (monotonic-filtered) */
  from: number
  to: number
  startPct: number
  endPct: number
  /** endPct - startPct, or null when only one sample exists */
  delta: number | null
  saturated: boolean
  /** largest gap between consecutive samples, seconds */
  maxGap: number
  /**
   * the delta is usable for a dollars-per-percent figure: at least two samples,
   * delta > 0, not saturated, no sampler gap above `MEASURED_MAX_GAP`, and the
   * usage below covers `from..to` only
   */
  measured: boolean
  usage: WindowUsage
  /** usage.cost / delta, only when `measured`; else null */
  dollarsPerPercent: number | null
  /** the block's reset is in the past */
  ended: boolean
}

/** a sampler gap above this inside a block disqualifies it from the chart */
export const MEASURED_MAX_GAP = 20 * 60

/** the surface split of the weekly meter, from `seven_day_breakdown` in usage-raw.jsonl */
export interface WeeklyBreakdown {
  /** when the sample that carried it was taken */
  at: number
  /** percent of the week's usage per surface key: `claude_code`, `chat`, `cowork`, `other` */
  rows: Record<string, number>
}

/** one weekly window of the 7-day meter and the Fable meter */
export interface WeekSummary {
  /** the weekly reset that closes this window */
  resetsAt: number
  start: number
  end: number
  /** the current window: `end` is now and the figures keep moving */
  partial: boolean
  /** first and last api sample inside the window, the span the usage covers */
  from: number
  to: number
  startPct: number
  endPct: number
  delta: number | null
  /**
   * the last breakdown sampled before the reset (or the latest, when partial);
   * null before 14 Sep 2026 when the sampler started keeping the raw payload
   */
  breakdown: WeeklyBreakdown | null
  /** percent of the meter attributed to Chats, from the breakdown; null without one */
  chatsPercent: number | null
  usage: WindowUsage
  /** usage.cost / (delta - chatsPercent-adjusted delta); null without a delta or a breakdown */
  dollarsPerPercent: number | null
  fable: {
    model: string | null
    startPct: number | null
    endPct: number | null
    delta: number | null
    /** fable-family list cost over `from..to` */
    cost: number
    /** cost / delta when delta > 0, else null */
    dollarsPerPercent: number | null
  }
}

export interface SubValue {
  /** the current weekly window's list-price total so far */
  weekCost: number
  weekStart: number
  /** the calendar month (Europe/Prague) to date */
  monthCost: number
  monthStart: number
  planUsd: number
  /** the plan the price belongs to, so the page never bakes "Max 5x" into a sentence */
  planName: string
}

/** `GET /api/history` */
export interface ClaudeHistory {
  /**
   * the day the sampler's first api reading fell on, so the page never claims
   * history it has no samples for. null with an empty log: there is no history
   * yet, which the page says rather than drawing an axis from a date.
   */
  since: number | null
  now: number
  /** oldest first */
  blocks: BlockSummary[]
  /** oldest first */
  weeks: WeekSummary[]
  subValue: SubValue
  /** the index is still building; every figure above may be missing requests */
  indexing: boolean
  caveat: string
  sources: { limits: string; usageRaw: string; index: string }
}

/** one weekly window of the Codex meter */
export interface CodexWindow {
  resetsAt: number
  start: number
  end: number
  partial: boolean
  /** first and last reading inside the window */
  from: number
  to: number
  startPct: number
  endPct: number
  delta: number | null
  /** rate-card credits spent in `from..to` (calls deduplicated by response id) */
  credits: number
  creditsPerPercent: number | null
  /** api list price, usd, of the same calls; null when any model is unknown to the price table */
  costUsd: number | null
  /**
   * the part of `costUsd` the price table could answer: the known models alone.
   * lets the ui draw a window that has an unknown model in it, flagged as short
   * of the truth, instead of drawing nothing
   */
  pricedCostUsd: number
  byModel: Record<string, { calls: number; input: number; cached: number; output: number; credits: number; costUsd: number | null }>
  /** models seen in the window with no list-price row; never silently priced */
  unknownModels: string[]
  calls: number
}

/** one row of the OpenAI api list-price table, usd per million tokens */
export interface OpenAiPrice {
  input: number
  cachedInput: number
  output: number
}

/** `GET /api/history/codex` */
export interface CodexHistory {
  now: number
  /** false when no codex binary was found: the page hides Codex entirely rather than showing an empty section */
  installed: boolean
  /** oldest first */
  windows: CodexWindow[]
  /** `pricedMonthCostUsd` is `monthCostUsd` over the known models alone, always a number */
  subValue: {
    monthCostUsd: number | null
    pricedMonthCostUsd: number
    monthStart: number
    planUsd: number
    planName: string
    unknownModels: string[]
  }
  prices: { source: string; readAt: string; models: Record<string, OpenAiPrice> }
  sources: { usage: string; rollouts: string }
}

/** one request on a session's time axis */
export interface RequestPoint {
  t: number
  model: string
  family: Family
  cost: number
  tokens: Tokens
  priced: boolean
  /** the effort level a Claude transcript recorded; null when it recorded none, absent on a Codex call */
  effort?: Effort | null
}

/** the parent transcript or one subagent transcript of a session */
export interface AgentLane {
  file: string
  agent: boolean
  /** the subagent file name without `.jsonl`, or `main` */
  label: string
  cost: number
  tokens: number
  requests: RequestPoint[]
  start: number
  end: number
}

/** `GET /api/session/:id` */
export interface SessionDetail {
  sessionId: string
  project: string
  title: string | null
  start: number
  end: number
  cost: number
  tokens: number
  requests: number
  live: boolean
  parent: AgentLane
  subagents: AgentLane[]
  /** null when no AgentsView is configured; the link site renders nothing rather than a dead anchor */
  agentsview: string | null
  /** credits for a Codex thread; list-price dollars when absent */
  unit?: 'credits'
}

/** a stretch of activity on a lane: requests closer than `LANE_GAP` merged */
export interface LaneSegment {
  start: number
  end: number
  cost: number
  requests: number
  /** subagent transcripts active inside this segment; 0 means the parent alone */
  agents: number
}

/** requests further apart than this open a new segment */
export const LANE_GAP = 5 * 60

/** one row of the day lanes */
export interface Lane {
  id: string
  /** `claude`, or T3's provider name for the others: `antigravity`, `codex`, `opencode` */
  kind: string
  title: string
  /** a Claude lane's T3 Code thread title when T3 ran the session, else null; fall back to `title` */
  shortTitle: string | null
  project: string
  start: number
  end: number
  live: boolean
  /** Claude only; a T3 thread has its stretches of activity and nothing else */
  cost: number | null
  tokens: number | null
  requests: number
  agents: number
  segments: LaneSegment[]
  /** the thread's first message ever, when it is older than this window */
  began?: number | null
}

/** what `/api/state` says about the transcript index */
export interface IndexProgress {
  /** a build is running now */
  building: boolean
  /** files indexed so far in this build, and the total it found */
  done: number
  total: number
  /** when the last full pass finished; null before the first ever */
  builtAt: number | null
  /** the index has never completed: history and lanes may be missing requests */
  cold: boolean
  /**
   * files the last pass could not read or store, and that are still on disk. a
   * completed pass with a non-zero count is incomplete, and the page says so.
   */
  failed: number
  /**
   * files indexed under an older parser and not reread yet. their requests are
   * in every figure but carry `effort: null` until the reread reaches them, so
   * while this is above 0 a null effort may still fill in. 0 once they are done.
   */
  stale: number
}
