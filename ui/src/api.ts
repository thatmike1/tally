import type { RangeLanes, RangeMeterSplit, RangeSplit } from '../../server/range'
import type { State } from '../../server/state'
import type { SplitUsage } from '../../server/usage'
import type {
  AgentLane,
  BlockSummary,
  ClaudeHistory,
  CodexHistory,
  CodexWindow,
  RequestPoint,
  SessionDetail,
  WeekSummary,
  WindowUsage,
} from '../../server/history-types'

export type { RangeLanes, RangeMeterSplit, RangeSplit, SplitUsage, State }
export type {
  AgentLane,
  BlockSummary,
  ClaudeHistory,
  CodexHistory,
  CodexWindow,
  RequestPoint,
  SessionDetail,
  WeekSummary,
  WindowUsage,
}
export type SessionRow = State['split'] extends { sessions: (infer T)[] } | null ? T : never
export type OtherRow = State['others'][number]
export type Lane = State['day']['lanes'][number]

/**
 * `peek` reads the state without moving the "last looked" marker. the first load
 * of a page marks the look; the polls after it must not, or the marker would
 * always sit on now and say nothing.
 */
export type WeekMode = 'recent' | 'whole'

/** an api answer that was not 200, carrying the status so a 404 can read differently */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** the server's own `{ error }` line when it sends one, else the bare status */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    let message = `tally server answered ${response.status}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // a non-json error body tells us nothing the status has not already said
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

export async function fetchState(peek: boolean, week: WeekMode = 'recent'): Promise<State> {
  const query = [peek ? 'peek' : '', week === 'whole' ? 'week=whole' : ''].filter(Boolean).join('&')
  return await getJson<State>(query ? `/api/state?${query}` : '/api/state')
}

/** the page as it stood at `at`, for a history drill-in; never moves the marker */
export async function fetchStateAt(at: number): Promise<State> {
  return await getJson<State>(`/api/state?at=${Math.round(at)}&peek`)
}

export async function fetchHistory(): Promise<ClaudeHistory> {
  return await getJson<ClaudeHistory>('/api/history')
}

export async function fetchCodexHistory(): Promise<CodexHistory> {
  return await getJson<CodexHistory>('/api/history/codex')
}

/** one session; `at` freezes it at a past instant (the server honours it for Codex threads) */
export async function fetchSession(id: string, at?: number): Promise<SessionDetail> {
  const path = `/api/session/${encodeURIComponent(id)}`
  return await getJson<SessionDetail>(at === undefined ? path : `${path}?at=${Math.round(at)}`)
}

/** whatever went wrong, as one line a warn paragraph can show */
export function errorLine(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem)
}

/**
 * the transcript link for a session, or null when no AgentsView is configured:
 * `state.agentsviewUrl` carries the base, and a machine without AgentsView gets
 * no link at all rather than a dead one.
 */
export function agentsview(base: string | null, sessionId: string): string | null {
  return base === null ? null : `${base}/sessions/${sessionId}?msg=last`
}
