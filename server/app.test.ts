// the routes, over the frozen fixture home.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { defaultConfig } from './config'
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
    // no AgentsView configured, so there is no transcript link to offer
    expect(body.agentsview).toBeNull()
    expect(body.start).toBeLessThanOrEqual(body.end)
  })

  it('links the transcript to the configured AgentsView', async () => {
    const withAgentsview = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
      lastLookedPath: join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked'),
      config: { ...defaultConfig(), agentsviewUrl: 'http://127.0.0.1:8080' },
    })
    const body = (await (await withAgentsview.request(`/api/session/${WITH_AGENTS}`)).json()) as SessionDetail
    expect(body.agentsview).toBe(`http://127.0.0.1:8080/sessions/${WITH_AGENTS}?msg=last`)
    const state = (await (await withAgentsview.request('/api/state?peek')).json()) as { agentsviewUrl: string }
    expect(state.agentsviewUrl).toBe('http://127.0.0.1:8080')
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

describe('GET /api/session/codex:<id>', () => {
  /** a home with one Codex thread: a lead call at t=100 and a subagent call at t=300 */
  function codexApp() {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-home-'))
    const dir = join(home, '.codex', 'sessions', '2026', '09', '15')
    mkdirSync(dir, { recursive: true })
    const line = (t: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: new Date(t * 1000).toISOString(), type, payload })
    const rollout = (id: string, meta: Record<string, unknown>, response: string, t: number) =>
      [
        line(0, 'session_meta', { id, session_id: 'lead', cwd: '/home/m/git/tally', model_provider: 'openai', ...meta }),
        line(0, 'turn_context', { model: 'gpt-5.6-sol' }),
        line(t, 'token_usage_record', { thread_id: id, response_id: response, usage: { input_tokens: 10_000, output_tokens: 0 } }),
      ].join('\n')
    writeFileSync(join(dir, 'rollout-2026-09-15T10-00-00-lead.jsonl'), rollout('lead', {}, 'r1', 100))
    writeFileSync(
      join(dir, 'rollout-2026-09-15T10-05-00-kid.jsonl'),
      rollout('kid', { parent_thread_id: 'lead', source: { subagent: { thread_spawn: { parent_thread_id: 'lead', agent_nickname: 'Tesla', agent_role: 'worker' } } } }, 'r2', 300),
    )
    return createApp({ home, now: NOW, recordLook: false, lastLookedPath: join(home, 'last-looked') })
  }

  it('explodes a Codex thread into its lead and subagent lanes', async () => {
    const response = await codexApp().request('/api/session/codex:lead')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SessionDetail & { unit: string }
    expect(body).toMatchObject({ sessionId: 'codex:lead', unit: 'credits', requests: 2, agentsview: null })
    expect(body.parent.label).toBe('main')
    expect(body.subagents.map((lane) => lane.label)).toEqual(['Tesla · worker'])
  })

  it('freezes the thread at `at` and rejects an `at` that is not a number', async () => {
    const app = codexApp()
    const frozen = (await (await app.request('/api/session/codex:lead?at=200')).json()) as SessionDetail
    expect(frozen.requests).toBe(1)
    expect(frozen.subagents).toEqual([])
    expect((await app.request('/api/session/codex:lead?at=50')).status).toBe(404)
    expect((await app.request('/api/session/codex:lead?at=soon')).status).toBe(400)
  })

  it('404s a thread no rollout carries', async () => {
    const response = await codexApp().request('/api/session/codex:nobody')
    expect(response.status).toBe(404)
    expect((await response.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('codex:nobody') })
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
    expect(body.agentsviewUrl).toBeNull()
  })

  it('hides Codex when the machine has no codex binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-no-codex-'))
    const bare = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
      lastLookedPath: join(dir, 'last-looked'),
      codexInstalled: false,
    })
    const state = (await (await bare.request('/api/state?peek')).json()) as Record<string, any>
    expect(state.codex).toMatchObject({ status: 'absent', usedPercent: null, split: null })
    const history = (await (await bare.request('/api/history/codex')).json()) as { installed: boolean }
    expect(history.installed).toBe(false)
  })
})
