// per-request records from the local Claude Code transcripts.
//
// the parsing rule is burn.py's, unchanged: one API request writes several JSONL
// lines sharing a message id, the cache figures repeat and output_tokens grows,
// so the last line for a (file, message id) is the true total.
//
// one deliberate difference from `jobs/extract.py`: a subagent record's session
// id is the *parent* session (the directory the `subagents/` folder sits in),
// because the page ranks whole runs. extract.py used the agent file name, which
// was fine there since the proof only ever aggregated per block.
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { costOf, familyOf, isPriced, type Family, type Tokens } from './prices'

export interface RequestRecord extends Tokens {
  /** unix seconds */
  t: number
  file: string
  mid: string
  project: string
  /** parent session id; subagent files are folded into it */
  sessionId: string
  agent: boolean
  model: string
  family: Family
  priced: boolean
  cost: number
}

export interface SessionMeta {
  sessionId: string
  project: string
  title: string | null
  /** mtime of the lead transcript, unix seconds */
  modified: number
  /** the working directory the session ran in, when a line carried one */
  cwd?: string | null
}

export interface TranscriptFile {
  path: string
  sessionId: string
  project: string
  agent: boolean
  /** unix seconds */
  mtime: number
  /** bytes; the index keys a file's freshness on mtime and size together */
  size: number
}

export function projectsRoot(home = homedir()): string {
  return join(home, '.claude', 'projects')
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** every lead transcript and every subagent transcript under `~/.claude/projects` */
export function transcriptFiles(root = projectsRoot()): TranscriptFile[] {
  const out: TranscriptFile[] = []
  for (const project of safeReaddir(root)) {
    const projectDir = join(root, project)
    for (const entry of safeReaddir(projectDir)) {
      const path = join(projectDir, entry)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isFile() && entry.endsWith('.jsonl')) {
        out.push({
          path,
          sessionId: entry.slice(0, -6),
          project,
          agent: false,
          mtime: st.mtimeMs / 1000,
          size: st.size,
        })
        continue
      }
      if (!st.isDirectory()) continue
      const subagents = join(path, 'subagents')
      for (const agentFile of safeReaddir(subagents)) {
        if (!agentFile.endsWith('.jsonl')) continue
        const agentPath = join(subagents, agentFile)
        try {
          const ast = statSync(agentPath)
          out.push({
            path: agentPath,
            sessionId: entry,
            project,
            agent: true,
            mtime: ast.mtimeMs / 1000,
            size: ast.size,
          })
        } catch {
          // raced with a delete
        }
      }
    }
  }
  return out
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms / 1000
}

/** the first real user turn, as the session's title; command frames are skipped */
function titleFrom(line: Record<string, any>): string | null {
  if (line.type !== 'user' || line.isSidechain) return null
  const content = line.message?.content
  let text: string | null = null
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const block = content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    text = block ? block.text : null
  }
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('<')) return null
  return trimmed.replace(/\s+/g, ' ').slice(0, 90)
}

export interface ParsedTranscript {
  /** one per (message id) in this file, in the order the ids first appeared */
  records: RequestRecord[]
  /** the lead transcript's first real user turn; always null for an agent file */
  title: string | null
  /** the working directory a line carried, when one did */
  cwd: string | null
  lines: number
}

/**
 * a line that cannot carry a request, a title or a cwd is never JSON-parsed.
 *
 * the tree is ten gigabytes and most of it is tool output, so the substring
 * test decides what gets parsed. it is deliberately loose: a line that could
 * produce any of the three always contains one of these keys, whatever the
 * spacing of the json.
 */
function mayMatter(raw: string, wantTitle: boolean, wantCwd: boolean): boolean {
  if (raw.includes('"usage"')) return true
  if (wantTitle && raw.includes('"user"')) return true
  if (wantCwd && raw.includes('"cwd"')) return true
  return false
}

/**
 * parse one transcript file: every request with `start <= t < end`, the title
 * and the cwd.
 *
 * this is the only place a transcript line becomes a record. `scan` and the
 * index both come through here so the two can never drift apart.
 */
export async function parseTranscript(
  file: TranscriptFile,
  start = 0,
  end = Number.POSITIVE_INFINITY,
): Promise<ParsedTranscript> {
  const last = new Map<string, RequestRecord>()
  let title: string | null = null
  let cwd: string | null = null
  let lines = 0
  const stream = createReadStream(file.path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const raw of reader) {
      lines++
      if (!raw) continue
      const wantTitle = !file.agent && title === null
      if (!mayMatter(raw, wantTitle, cwd === null)) continue
      let line: Record<string, any>
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      if (cwd === null && typeof line.cwd === 'string' && line.cwd) cwd = line.cwd
      if (wantTitle) title = titleFrom(line)
      if (line.type !== 'assistant') continue
      const t = parseTimestamp(line.timestamp)
      if (t === null || t < start || t >= end) continue
      const message = line.message ?? {}
      const mid = message.id
      const usage = message.usage
      if (!mid || !usage) continue
      const model: string = message.model ?? '?'
      const cacheWrite = usage.cache_creation ?? null
      const cw1h = Number(cacheWrite?.ephemeral_1h_input_tokens ?? 0)
      const cw5m = cacheWrite
        ? Number(cacheWrite.ephemeral_5m_input_tokens ?? 0)
        : Number(usage.cache_creation_input_tokens ?? 0)
      const tokens: Tokens = {
        in: Number(usage.input_tokens ?? 0),
        cw1h,
        cw5m,
        cr: Number(usage.cache_read_input_tokens ?? 0),
        out: Number(usage.output_tokens ?? 0),
      }
      last.set(mid, {
        ...tokens,
        t,
        file: file.path,
        mid,
        project: file.project,
        sessionId: file.sessionId,
        agent: file.agent || Boolean(line.isSidechain),
        model,
        family: familyOf(model),
        priced: isPriced(model),
        cost: costOf(model, tokens),
      })
    }
  } finally {
    reader.close()
    stream.close()
  }
  return { records: [...last.values()], title, cwd, lines }
}

export interface ScanResult {
  records: RequestRecord[]
  sessions: Map<string, SessionMeta>
}

/**
 * every request with `start <= t < end`, plus a title per session.
 *
 * files untouched since `start` are skipped by mtime, which is what keeps a
 * 2000-session transcript directory cheap to scan for one five-hour block.
 */
export async function scan(start: number, end: number, root = projectsRoot()): Promise<ScanResult> {
  const records: RequestRecord[] = []
  const sessions = new Map<string, SessionMeta>()
  for (const file of transcriptFiles(root)) {
    if (file.mtime < start) continue
    const parsed = await parseTranscript(file, start, end)
    for (const record of parsed.records) records.push(record)
    if (!file.agent) {
      sessions.set(file.sessionId, {
        sessionId: file.sessionId,
        project: file.project,
        title: parsed.title,
        modified: file.mtime,
        cwd: parsed.cwd,
      })
    }
  }
  records.sort((a, b) => a.t - b.t)
  return { records, sessions }
}
