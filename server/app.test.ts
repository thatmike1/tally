// the routes, over the frozen fixture home.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import type { SessionDetail } from './history-types'
import { TranscriptIndex } from './transcript-index'
import { projectsRoot } from './transcripts'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
/** the fixture session with two subagent transcripts under it */
const WITH_AGENTS = '6540615c-78fa-4cce-ad83-291217cfc6ae'
const NOW = 1789062400

function app(index?: TranscriptIndex) {
  return createApp({
    home: FIXTURE_HOME,
    now: NOW,
    index,
    recordLook: false,
    lastLookedPath: join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked'),
  })
}

async function detail(index?: TranscriptIndex): Promise<SessionDetail> {
  const response = await app(index).request(`/api/session/${WITH_AGENTS}`)
  expect(response.status).toBe(200)
  return (await response.json()) as SessionDetail
}

describe('GET /api/session/:id', () => {
  it('explodes a session into its parent and one lane per subagent file', async () => {
    const body = await detail()
    expect(body.sessionId).toBe(WITH_AGENTS)
    expect(body.subagents.length).toBeGreaterThan(0)
    expect(body.subagents.every((lane) => lane.agent && lane.file.includes('/subagents/'))).toBe(true)
    expect(new Set(body.subagents.map((lane) => lane.file)).size).toBe(body.subagents.length)
    expect(body.parent.label).toBe('main')
    expect(body.parent.agent).toBe(false)
    expect(body.parent.requests.length).toBeGreaterThan(0)
    const times = body.parent.requests.map((request) => request.t)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(body.requests).toBe(
      body.parent.requests.length + body.subagents.reduce((sum, lane) => sum + lane.requests.length, 0),
    )
    expect(body.cost).toBeGreaterThan(0)
    expect(body.tokens).toBeGreaterThan(0)
    expect(body.agentsview).toBe(`http://127.0.0.1:8080/sessions/${WITH_AGENTS}?msg=last`)
    expect(body.start).toBeLessThanOrEqual(body.end)
  })

  it('answers the same detail out of the index as off the transcripts', async () => {
    const index = new TranscriptIndex({ root: projectsRoot(FIXTURE_HOME), path: ':memory:' })
    await index.refresh()
    expect(await detail(index)).toEqual(await detail())
    index.close()
  })

  it('404s an id no transcript carries', async () => {
    const response = await app().request('/api/session/not-a-session')
    expect(response.status).toBe(404)
    expect((await response.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('not-a-session') })
  })
})

describe('GET /api/state', () => {
  it('carries the index progress and the day lanes', async () => {
    const response = await app().request('/api/state?peek')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, any>
    expect(body.index).toMatchObject({ building: false, cold: true })
    expect(body.day.lanes.length).toBeGreaterThan(0)
    expect(body.day.lanesError).toBeUndefined()
    // the sources the page can trace a wrong number home through, and no others
    expect(Object.keys(body.sources).sort()).toEqual(['index', 'limits', 't3', 'transcripts'])
    expect(body.sources.index).toContain('transcripts.sqlite')
  })
})
