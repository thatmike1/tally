// the transcript parser on the lines the fixture tree never carries: broken json,
// command frames, old cache fields, requests outside the window, stray files.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTranscript, scan, transcriptFiles, type TranscriptFile } from './transcripts'

const T0 = Date.UTC(2026, 9, 20, 10) / 1000
const iso = (t: number) => new Date(t * 1000).toISOString()

function assistant(mid: string, t: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'assistant', timestamp: iso(t), message: { id: mid, model: 'claude-opus-5-5', usage }, ...extra })
}

function user(content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
}

/** one transcript file in a fresh projects root */
function transcript(lines: string[], agent = false): TranscriptFile {
  const root = mkdtempSync(join(tmpdir(), 'tally-parse-'))
  const path = join(root, 'session.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  return { path, sessionId: 'session', project: '-home-me-git-app', agent, mtime: T0, size: 1 }
}

describe('parseTranscript', () => {
  it('skips a line that is not json and keeps reading', async () => {
    const parsed = await parseTranscript(transcript(['{"usage": broken', assistant('m1', T0, { input_tokens: 5 })]))
    expect(parsed.records.map((record) => record.mid)).toEqual(['m1'])
    expect(parsed.lines).toBe(2)
  })

  it('takes the title from a text block and skips command frames', async () => {
    const parsed = await parseTranscript(
      transcript([
        user('<command-name>/clear</command-name>'),
        user([{ type: 'image' }, { type: 'text', text: '  fix   the\nchart  ' }]),
        user('a later turn'),
      ]),
    )
    expect(parsed.title).toBe('fix the chart')
  })

  it('clips a long first turn to 90 characters', async () => {
    const parsed = await parseTranscript(transcript([user('x'.repeat(200))]))
    expect(parsed.title).toHaveLength(90)
  })

  it('reads no title off a sidechain turn, an empty turn, or an agent file', async () => {
    expect((await parseTranscript(transcript([user('from a subagent', { isSidechain: true })]))).title).toBeNull()
    expect((await parseTranscript(transcript([user([{ type: 'tool_result', content: 'ok' }]), user('   ')]))).title).toBeNull()
    expect((await parseTranscript(transcript([user('the agent prompt')], true))).title).toBeNull()
  })

  it('keeps the first cwd a line carries', async () => {
    const parsed = await parseTranscript(
      transcript([JSON.stringify({ type: 'system', cwd: '/home/me/git/app' }), JSON.stringify({ type: 'system', cwd: '/elsewhere' })]),
    )
    expect(parsed.cwd).toBe('/home/me/git/app')
  })

  it('counts an old-style cache write as five-minute and a missing model as unknown', async () => {
    const parsed = await parseTranscript(
      transcript([
        JSON.stringify({
          type: 'assistant',
          timestamp: iso(T0),
          message: { id: 'm1', usage: { input_tokens: 1, cache_creation_input_tokens: 40, cache_read_input_tokens: 7, output_tokens: 3 } },
        }),
      ]),
    )
    expect(parsed.records[0]).toMatchObject({ model: '?', in: 1, cw5m: 40, cw1h: 0, cr: 7, out: 3, priced: false })
  })

  it('splits a new-style cache write by its ttl', async () => {
    const usage = { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 }, cache_creation_input_tokens: 40 }
    const parsed = await parseTranscript(transcript([assistant('m1', T0, usage)]))
    expect(parsed.records[0]).toMatchObject({ cw5m: 10, cw1h: 30 })
  })

  it('leaves out requests outside the window, without a time, an id or usage', async () => {
    const parsed = await parseTranscript(
      transcript([
        assistant('before', T0 - 10, { input_tokens: 1 }),
        assistant('inside', T0, { input_tokens: 1 }),
        assistant('at-end', T0 + 60, { input_tokens: 1 }),
        JSON.stringify({ type: 'assistant', timestamp: 'not a time', message: { id: 'bad-time', usage: { input_tokens: 1 } } }),
        JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { usage: { input_tokens: 1 } } }),
        JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { id: 'no-usage' }, usage: 'mentioned' }),
      ]),
      T0,
      T0 + 60,
    )
    expect(parsed.records.map((record) => record.mid)).toEqual(['inside'])
  })

  it('marks a sidechain request in a lead file as an agent request', async () => {
    const parsed = await parseTranscript(transcript([assistant('m1', T0, { input_tokens: 1 }, { isSidechain: true })]))
    expect(parsed.records[0]?.agent).toBe(true)
  })
})

describe('transcriptFiles', () => {
  it('lists lead and subagent transcripts and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-files-'))
    const project = join(root, '-home-me-git-app')
    mkdirSync(join(project, 'lead', 'subagents'), { recursive: true })
    writeFileSync(join(project, 'lead.jsonl'), '')
    writeFileSync(join(project, 'notes.txt'), '')
    writeFileSync(join(project, 'lead', 'subagents', 'agent-a.jsonl'), '')
    writeFileSync(join(project, 'lead', 'subagents', 'agent-a.meta.json'), '')
    const files = transcriptFiles(root)
    expect(files.map((file) => [file.sessionId, file.agent, file.path.slice(project.length).replaceAll('\\', '/')])).toEqual(
      expect.arrayContaining([
        ['lead', false, '/lead.jsonl'],
        ['lead', true, '/lead/subagents/agent-a.jsonl'],
      ]),
    )
    expect(files).toHaveLength(2)
  })

  it('reads an empty list off a root that does not exist', () => {
    expect(transcriptFiles(join(tmpdir(), 'tally-no-such-root'))).toEqual([])
  })
})

describe('scan', () => {
  it('skips a file untouched since the window opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-scan-'))
    const project = join(root, '-home-me-git-app')
    mkdirSync(project)
    const old = join(project, 'old.jsonl')
    writeFileSync(old, assistant('m-old', T0, { input_tokens: 1 }) + '\n')
    utimesSync(old, T0 - 3600, T0 - 3600)
    const fresh = join(project, 'fresh.jsonl')
    writeFileSync(fresh, assistant('m-new', T0, { input_tokens: 1 }) + '\n')
    utimesSync(fresh, T0 + 60, T0 + 60)
    const result = await scan(T0 - 60, T0 + 600, root)
    expect(result.records.map((record) => record.mid)).toEqual(['m-new'])
    expect([...result.sessions.keys()]).toEqual(['fresh'])
  })
})
