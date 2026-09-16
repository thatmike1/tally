// the index against the parser it caches: same records, and a file that has not
// changed is never read twice.
import { chmodSync, cpSync, mkdtempSync, appendFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptIndex } from './transcript-index'
import { projectsRoot, scan, transcriptFiles, type RequestRecord } from './transcripts'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
const FIXTURE_ROOT = projectsRoot(FIXTURE_HOME)

const temps: string[] = []

/** a writable copy of the fixture transcripts, so a test can touch one */
function copyRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tally-index-'))
  temps.push(dir)
  const root = join(dir, 'projects')
  cpSync(FIXTURE_ROOT, root, { recursive: true })
  return root
}

function key(record: RequestRecord): string {
  return `${record.t} ${record.file} ${record.mid}`
}

function sorted(records: RequestRecord[]): RequestRecord[] {
  return [...records].sort((a, b) => key(a).localeCompare(key(b)))
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TranscriptIndex', () => {
  it('yields exactly the records scan yields for the same window', async () => {
    const index = new TranscriptIndex({ root: FIXTURE_ROOT, path: ':memory:' })
    await index.refresh()
    const from = 0
    const to = 9_999_999_999
    const live = await scan(from, to, FIXTURE_ROOT)
    const indexed = index.query(from, to)
    expect(sorted(indexed.records)).toEqual(sorted(live.records))

    // and the same again for a window that only covers part of the fixture
    const cut = sorted(live.records)[Math.floor(live.records.length / 2)]!.t
    expect(sorted(index.query(cut, to).records)).toEqual(sorted((await scan(cut, to, FIXTURE_ROOT)).records))

    // the sessions behind them, with the titles the parser read
    expect([...indexed.sessions.keys()].sort()).toEqual([...live.sessions.keys()].sort())
    for (const [id, meta] of indexed.sessions) expect(meta.title).toBe(live.sessions.get(id)!.title)
    index.close()
  })

  it('never reads an unchanged file twice', async () => {
    const root = copyRoot()
    const index = new TranscriptIndex({ root, path: ':memory:' })
    const first = await index.refresh()
    expect(first.seen).toBe(transcriptFiles(root).length)
    expect(first.parsed).toBe(first.seen)
    expect(first.skipped).toBe(0)
    expect(first.records).toBeGreaterThan(0)

    const second = await index.refresh()
    expect(second.parsed).toBe(0)
    expect(second.skipped).toBe(second.seen)
    expect(second.records).toBe(0)
    // and the second pass answers the same window as the first
    expect(sorted(index.query(0, 9e9).records)).toEqual(sorted((await scan(0, 9e9, root)).records))
    index.close()
  })

  it('reparses a file whose size changed, and one whose mtime moved', async () => {
    const root = copyRoot()
    const index = new TranscriptIndex({ root, path: ':memory:' })
    await index.refresh()

    const file = transcriptFiles(root).find((f) => !f.agent)!
    const before = index.query(0, 9e9).records.length
    appendFileSync(file.path, `${JSON.stringify({ type: 'other', note: 'appended' })}\n`)
    const grown = await index.refresh()
    expect(grown.parsed).toBe(1)
    expect(grown.skipped).toBe(grown.seen - 1)
    // the appended line carries no usage, so the record count holds
    expect(index.query(0, 9e9).records.length).toBe(before)

    const touched = statSync(file.path)
    utimesSync(file.path, touched.atime, new Date(touched.mtimeMs + 5000))
    const again = await index.refresh()
    expect(again.parsed).toBe(1)
    index.close()
  })

  it('drops the rows of a file that vanished', async () => {
    const root = copyRoot()
    const index = new TranscriptIndex({ root, path: ':memory:' })
    await index.refresh()
    const agent = transcriptFiles(root).find((f) => f.agent)!
    const had = index.query(0, 9e9).records.filter((r) => r.file === agent.path).length
    expect(had).toBeGreaterThan(0)
    rmSync(agent.path)
    const pass = await index.refresh()
    expect(pass.dropped).toBe(1)
    expect(index.query(0, 9e9).records.some((r) => r.file === agent.path)).toBe(false)
    index.close()
  })

  // root reads a mode-000 file anyway, so the failure this test needs cannot happen there
  it.skipIf(process.getuid?.() === 0)('counts a file it could not read and retries it next pass', async () => {
    const root = copyRoot()
    const unreadable = transcriptFiles(root).find((f) => !f.agent)!
    chmodSync(unreadable.path, 0o000)
    const index = new TranscriptIndex({ root, path: ':memory:' })

    const first = await index.refresh()
    expect(first.failed).toBe(1)
    expect(first.parsed).toBe(first.seen - 1)
    expect(index.progress().failed).toBe(1)
    // not in `files`: nothing claims it was indexed, so the next pass reads it
    expect(index.fileState(unreadable.path)).toBeNull()
    expect(index.query(0, 9e9).records.some((r) => r.file === unreadable.path)).toBe(false)
    // the pass still completes: one unreadable file must not block the build forever
    expect(index.progress().builtAt).toBeGreaterThan(0)
    expect(index.progress().cold).toBe(false)

    chmodSync(unreadable.path, 0o644)
    const second = await index.refresh()
    expect(second.failed).toBe(0)
    expect(second.parsed).toBe(1)
    expect(index.progress().failed).toBe(0)
    expect(index.fileState(unreadable.path)).not.toBeNull()
    expect(sorted(index.query(0, 9e9).records)).toEqual(sorted((await scan(0, 9e9, root)).records))
    index.close()
  })

  it('claims coverage only for windows the build has reached', async () => {
    const index = new TranscriptIndex({ root: FIXTURE_ROOT, path: ':memory:' })
    expect(index.progress()).toMatchObject({ building: false, cold: true, builtAt: null })
    expect(index.covers(0)).toBe(false)
    const pass = index.refresh()
    expect(index.covers(0)).toBe(false)
    await pass
    expect(index.covers(0)).toBe(true)
    const progress = index.progress()
    expect(progress.cold).toBe(false)
    expect(progress.building).toBe(false)
    expect(progress.builtAt).toBeGreaterThan(0)
    expect(progress.done).toBe(progress.total)
    index.close()
  })

  it('keeps a session\'s parent and subagent requests together', async () => {
    const index = new TranscriptIndex({ root: FIXTURE_ROOT, path: ':memory:' })
    await index.refresh()
    const all = index.query(0, 9e9).records
    const withAgents = all.find((record) => record.file.includes('/subagents/'))!
    const session = index.sessionRecords(withAgents.sessionId)
    expect(session.length).toBe(all.filter((r) => r.sessionId === withAgents.sessionId).length)
    expect(new Set(session.map((r) => r.file)).size).toBeGreaterThan(1)
    expect(session.map((r) => r.t)).toEqual([...session.map((r) => r.t)].sort((a, b) => a - b))
    index.close()
  })

  it('survives a restart, reading the built index back off disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-index-db-'))
    temps.push(dir)
    const path = join(dir, 'transcripts.sqlite')
    const first = new TranscriptIndex({ root: FIXTURE_ROOT, path })
    await first.refresh()
    const before = first.query(0, 9e9).records
    first.close()

    const second = new TranscriptIndex({ root: FIXTURE_ROOT, path })
    expect(second.progress().cold).toBe(false)
    expect(second.covers(0)).toBe(true)
    expect(sorted(second.query(0, 9e9).records)).toEqual(sorted(before))
    const pass = await second.refresh()
    expect(pass.parsed).toBe(0)
    second.close()
  })
})
