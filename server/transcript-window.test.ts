import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TranscriptIndex } from './transcript-index'
import { scan } from './transcripts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('attributes a streamed message to one window consistently before and after indexing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-stream-window-'))
  roots.push(root)
  const project = join(root, '-synthetic-project')
  mkdirSync(project)
  const frame = (t: number, input: number) => JSON.stringify({
    type: 'assistant', timestamp: new Date(t * 1000).toISOString(),
    message: { id: 'one-streamed-message', model: 'claude-opus-5-5', usage: { input_tokens: input } },
  })
  writeFileSync(join(project, 'lead.jsonl'), [frame(100, 10), frame(200, 20)].join('\n'))
  const index = new TranscriptIndex({ root, path: ':memory:' })
  try {
    await index.refresh()
    const early = await scan(50, 150, root)
    const late = await scan(150, 250, root)

    expect(early.records).toEqual(index.query(50, 150).records)
    expect(early.records).toEqual([])
    expect(late.records).toEqual(index.query(150, 250).records)
    expect(late.records.map((record) => [record.mid, record.in, record.t])).toEqual([
      ['one-streamed-message', 20, 200],
    ])
  } finally {
    index.close()
  }
})
