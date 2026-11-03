import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import type { SessionDetail } from './history-types'
import { TranscriptIndex } from './transcript-index'
import { projectsRoot } from './transcripts'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

function homeWithSession() {
  const home = mkdtempSync(join(tmpdir(), 'tally-frozen-review-'))
  homes.push(home)
  const project = join(projectsRoot(home), '-synthetic-project')
  const agents = join(project, 'lead', 'subagents')
  mkdirSync(agents, { recursive: true })
  const assistant = (id: string, t: number) => JSON.stringify({
    type: 'assistant', timestamp: new Date(t * 1000).toISOString(),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000 } },
  })
  writeFileSync(join(project, 'lead.jsonl'), [assistant('before', 100), assistant('after', 300)].join('\n'))
  writeFileSync(join(agents, 'agent-one.jsonl'), [assistant('before-child', 200), assistant('after-child', 400)].join('\n'))
  return home
}

describe('frozen Claude session detail', () => {
  it.each([false, true])('honours the cutoff for parent, agents and totals (index=%s)', async (indexed) => {
    const home = homeWithSession()
    const index = indexed ? new TranscriptIndex({ home, path: ':memory:' }) : null
    try {
      await index?.refresh()
      const app = createApp({ home, index, now: 1_000, recordLook: false })
      const response = await app.request('/api/session/lead?at=250')
      expect(response.status).toBe(200)
      const body = await response.json() as SessionDetail
      expect(body.requests).toBe(2)
      expect(body.cost).toBe(8)
      expect(body.tokens).toBe(2_000_000)
      expect(body.parent.requests.map((request) => request.t)).toEqual([100])
      expect(body.subagents[0]?.requests.map((request) => request.t)).toEqual([200])
      expect(body.end).toBe(200)

      const early = await (await app.request('/api/session/lead?at=100')).json() as SessionDetail
      expect(early.requests).toBe(1)
      expect(early.subagents).toEqual([])
      expect(early.end).toBe(100)

      const live = await (await app.request('/api/session/lead')).json() as SessionDetail
      expect(live.requests).toBe(4)
      expect((await app.request('/api/session/lead?at=50')).status).toBe(404)
      expect((await app.request('/api/session/lead?at=soon')).status).toBe(400)
    } finally {
      index?.close()
    }
  })
})
