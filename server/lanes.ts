// the day lanes, off tally's own transcript records.
//
// a lane shows activity, not span: a session that idled three hours is three
// hours of nothing between two stretches of work, and drawing it as one bar
// made it look like a three-hour eater. requests closer than `LANE_GAP` merge
// into a segment, and a segment carries how many subagent transcripts were
// writing inside it, which is the thickness the page draws.
import { LANE_GAP, type Lane, type LaneSegment } from './history-types'
import { totalTokens } from './prices'
import type { Thread } from './t3'
import type { RequestRecord, SessionMeta } from './transcripts'

/** a lead transcript written this recently is a session that is still running */
export const LIVE_WINDOW = 120

/** `…/<session>/subagents/<agent>.jsonl` is a fan-out file, not the lead transcript */
export function isSubagentFile(path: string): boolean {
  return path.includes('/subagents/')
}

/**
 * the directory a session ran in.
 *
 * the cwd off the transcript when a line carried one; otherwise Claude's own
 * encoding of it (`-home-thatmike1-git-x`) turned back into a path, the same
 * fallback cc-browse used, lossy where a directory name contains a dash.
 */
export function projectPath(project: string, cwd: string | null | undefined): string {
  if (cwd) return cwd
  if (project.startsWith('-')) return `/${project.replace(/^-+/, '').replace(/-/g, '/')}`
  return project
}

/**
 * merge requests into stretches of activity: a gap longer than `gap` opens a
 * new segment, and `agents` counts the distinct subagent transcripts that wrote
 * inside the one being built.
 */
export function segmentsOf(records: RequestRecord[], gap = LANE_GAP): LaneSegment[] {
  const sorted = [...records].sort((a, b) => a.t - b.t)
  const segments: LaneSegment[] = []
  let files = new Set<string>()
  for (const record of sorted) {
    const open = segments.at(-1)
    if (!open || record.t - open.end > gap) {
      files = new Set<string>()
      segments.push({ start: record.t, end: record.t, cost: 0, requests: 0, agents: 0 })
    }
    const segment = segments.at(-1)!
    segment.end = record.t
    segment.cost += record.cost
    segment.requests++
    if (isSubagentFile(record.file)) {
      files.add(record.file)
      segment.agents = files.size
    }
  }
  return segments
}

export interface LanesInput {
  /** may span more than the window; only `from <= t < to` counts */
  records: RequestRecord[]
  sessions: Map<string, SessionMeta>
  /** the non-Claude T3 threads that overlap the window */
  threads: Thread[]
  from: number
  to: number
  now: number
  liveWindow?: number
}

/**
 * one lane per Claude session with a request in the window, plus one per
 * non-Claude T3 thread: those get a span and no cost, because there is no usage
 * data for them and none is invented.
 */
export function buildLanes(input: LanesInput): Lane[] {
  const { records, sessions, threads, from, to, now } = input
  const liveWindow = input.liveWindow ?? LIVE_WINDOW
  const bySession = new Map<string, RequestRecord[]>()
  for (const record of records) {
    if (record.t < from || record.t >= to) continue
    const list = bySession.get(record.sessionId)
    if (list) list.push(record)
    else bySession.set(record.sessionId, [record])
  }

  const lanes: Lane[] = []
  for (const [sessionId, own] of bySession) {
    const meta = sessions.get(sessionId)
    const segments = segmentsOf(own)
    if (!segments.length) continue
    const agentFiles = new Set(own.filter((record) => isSubagentFile(record.file)).map((record) => record.file))
    let cost = 0
    let tokens = 0
    for (const record of own) {
      cost += record.cost
      tokens += totalTokens(record)
    }
    lanes.push({
      id: sessionId,
      kind: 'claude',
      title: meta?.title ?? sessionId.slice(0, 8),
      project: projectPath(meta?.project ?? own[0]!.project, meta?.cwd),
      start: segments[0]!.start,
      end: segments.at(-1)!.end,
      live: meta ? now - meta.modified < liveWindow : false,
      cost,
      tokens,
      requests: own.length,
      agents: agentFiles.size,
      segments,
    })
  }

  for (const thread of threads) {
    if (thread.end < from || thread.start >= to) continue
    lanes.push({
      id: thread.id,
      kind: thread.kind,
      title: thread.title,
      project: thread.project ?? 'other agents',
      start: thread.start,
      end: thread.end,
      live: thread.live,
      // no usage data exists for a non-Claude thread, so it gets a span and nothing else
      cost: null,
      tokens: null,
      requests: 0,
      agents: 0,
      segments: [{ start: thread.start, end: thread.end, cost: 0, requests: 0, agents: 0 }],
    })
  }

  lanes.sort((a, b) => a.start - b.start)
  return lanes
}
