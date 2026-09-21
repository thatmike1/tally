// one session, exploded: the lead transcript and every subagent transcript as
// its own row of requests. the lanes section is the same data one zoom level
// out, so the two read as one picture.
//
// the index answers a file whose mtime and size still match it; anything newer
// on disk is parsed there and then, so a click on a running session shows the
// requests it made a second ago.
import type { AgentLane, RequestPoint, SessionDetail } from './history-types'
import { totalTokens } from './prices'
import { LIVE_WINDOW, projectPath } from './lanes'
import type { TranscriptIndex } from './transcript-index'
import { parseTranscript, projectsRoot, transcriptFiles, type RequestRecord, type TranscriptFile } from './transcripts'

/**
 * the same url the page's `agentsview()` builds; transcripts are never rendered
 * here. null without a configured AgentsView, which is a machine that has none:
 * the link sites then render nothing rather than a dead anchor.
 */
export function agentsviewUrl(base: string | null, sessionId: string): string | null {
  return base === null ? null : `${base}/sessions/${sessionId}?msg=last`
}

export interface DetailOptions {
  /** `~/.claude/projects` unless a test points elsewhere */
  root?: string
  index?: TranscriptIndex | null
  now?: number
  /** base url of the local AgentsView; null means no transcript link */
  agentsviewUrl?: string | null
}

function pointOf(record: RequestRecord): RequestPoint {
  return {
    t: record.t,
    model: record.model,
    family: record.family,
    cost: record.cost,
    tokens: { in: record.in, cw1h: record.cw1h, cw5m: record.cw5m, cr: record.cr, out: record.out },
    priced: record.priced,
  }
}

function laneOf(file: TranscriptFile, records: RequestRecord[]): AgentLane {
  const requests = [...records].sort((a, b) => a.t - b.t)
  let cost = 0
  let tokens = 0
  for (const record of requests) {
    cost += record.cost
    tokens += totalTokens(record)
  }
  const name = file.path.split('/').at(-1) ?? file.path
  return {
    file: file.path,
    agent: file.agent,
    label: file.agent ? name.replace(/\.jsonl$/, '') : 'main',
    cost,
    tokens,
    requests: requests.map(pointOf),
    start: requests[0]?.t ?? file.mtime,
    end: requests.at(-1)?.t ?? file.mtime,
  }
}

/**
 * every request of one session, parent and subagents apart.
 *
 * null when no transcript carries that id, which is what the route turns into a
 * 404 rather than an empty session.
 */
export async function sessionDetail(sessionId: string, options: DetailOptions = {}): Promise<SessionDetail | null> {
  const root = options.root ?? projectsRoot()
  const now = options.now ?? Date.now() / 1000
  const index = options.index ?? null
  const files = transcriptFiles(root).filter((file) => file.sessionId === sessionId)
  if (!files.length) return null

  const lanes: AgentLane[] = []
  let title: string | null = null
  let cwd: string | null = null
  let project = ''
  let modified = 0
  for (const file of files) {
    const indexed = index?.fileState(file.path) ?? null
    const fresh = indexed !== null && indexed.mtime === file.mtime && indexed.size === file.size
    let records: RequestRecord[]
    if (fresh) {
      records = index!.fileRecords(file.path)
      if (!file.agent) {
        title = indexed.title
        cwd = indexed.cwd
      }
    } else {
      const parsed = await parseTranscript(file)
      records = parsed.records
      if (!file.agent) {
        title = parsed.title
        cwd = parsed.cwd
      }
    }
    if (!file.agent) {
      project = file.project
      modified = file.mtime
    }
    lanes.push(laneOf(file, records))
  }

  const leadIndex = files.findIndex((file) => !file.agent)
  // a session whose lead transcript is gone still has its fan-out files; show an empty parent
  const parent: AgentLane = lanes[leadIndex === -1 ? 0 : leadIndex]!
  const subagents = lanes.filter((lane) => lane !== parent)
  let cost = 0
  let tokens = 0
  let requests = 0
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const lane of lanes) {
    cost += lane.cost
    tokens += lane.tokens
    requests += lane.requests.length
    if (lane.requests.length) {
      start = Math.min(start, lane.start)
      end = Math.max(end, lane.end)
    }
  }
  if (!Number.isFinite(start)) {
    start = parent.start
    end = parent.end
  }

  return {
    sessionId,
    project: projectPath(project || files[0]!.project, cwd),
    title,
    start,
    end,
    cost,
    tokens,
    requests,
    live: modified > 0 && now - modified < LIVE_WINDOW,
    parent,
    subagents,
    agentsview: agentsviewUrl(options.agentsviewUrl ?? null, sessionId),
  }
}
