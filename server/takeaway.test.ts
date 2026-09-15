// tests for takeaway generation, caching, options parsing, and api route.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { parseOptions } from './main'
import { buildState, type State } from './state'
import {
  buildTakeawayPrompt,
  buildTakeawaySummary,
  getTakeaway,
  resetTakeawayCache,
  takeawayCacheKey,
  type CommandRunner,
} from './takeaway'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
const NOW = 1789138000

async function fixtureState(lastLooked?: string): Promise<State> {
  const dir = mkdtempSync(join(tmpdir(), 'tally-takeaway-test-'))
  const lookPath = join(dir, 'last-looked')
  if (lastLooked) {
    writeFileSync(lookPath, lastLooked)
  }
  return buildState({
    home: FIXTURE_HOME,
    now: NOW,
    ccbrowse: null,
    lastLookedPath: lookPath,
    recordLook: false,
  })
}

describe('buildTakeawaySummary and prompt', () => {
  it('formats compact summary with 5h, projection, verdicts, and sessions', async () => {
    const state = await fixtureState()
    state.split = {
      from: NOW - 3600,
      to: NOW,
      delta: 10,
      totalCost: 1.5,
      costBeforeFirstSample: 2.5,
      costAfterLastSample: 0.75,
      sessions: [
        {
          sessionId: 's1',
          project: 'p1',
          title: 'first heavy session',
          cost: 1.0,
          share: 0.6,
          points: 6.0,
          requests: 10,
          subagents: 1,
          start: NOW - 3000,
          end: NOW - 100,
          tokens: 5000,
          unpriced: false,
          kind: 'claude',
          live: false,
          color: '#d94f2a',
          fableShare: null,
          fablePoints: null,
        },
        {
          sessionId: 's2',
          project: 'p2',
          title: 'second session',
          cost: 0.5,
          share: 0.3,
          points: 3.0,
          requests: 4,
          subagents: 0,
          start: NOW - 2000,
          end: NOW - 500,
          tokens: 2000,
          unpriced: false,
          kind: 'claude',
          live: false,
          color: '#b5836a',
          fableShare: null,
          fablePoints: null,
        },
      ],
    }

    const summary = buildTakeawaySummary(state)
    expect(summary).toContain('5-hour meter: 70%')
    expect(summary).toContain('Projection:')
    expect(summary).toContain('Weekly meter:')
    expect(summary).toContain('Fable meter:')
    expect(summary).toContain('Top block sessions: 60% "first heavy session", 30% "second session"')
    expect(summary).toContain('Sampler warning: $2.50 ran before first sample')
    expect(summary).toContain('Sampler warning: $0.75 ran after last sample')

    const prompt = buildTakeawayPrompt(summary)
    expect(prompt).toContain('one sentence, under 20 words, plain English, no emoji')
    expect(prompt).toContain('what ate the block and whether the reset is safe')
  })
})

describe('takeawayCacheKey and getTakeaway', () => {
  it('keys cache on fiveHour.sampledAt and block.to', async () => {
    const state = await fixtureState()
    const key = takeawayCacheKey(state)
    expect(key).toBe(`${state.fiveHour!.sampledAt}:${state.block!.to}`)

    const emptyState = { ...state, fiveHour: null }
    expect(takeawayCacheKey(emptyState)).toBeNull()
  })

  it('runs command with gemini-3.8-flash-low and caches result', async () => {
    resetTakeawayCache()
    const state = await fixtureState()

    let callCount = 0
    let recordedCmd = ''
    let recordedArgs: string[] = []
    let recordedTimeout = 0

    const mockRunner: CommandRunner = async (cmd, args, timeoutMs) => {
      callCount++
      recordedCmd = cmd
      recordedArgs = args
      recordedTimeout = timeoutMs
      return { stdout: 'The heavy session consumed the block, but the reset is safe.\n', stderr: '' }
    }

    const res1 = await getTakeaway(state, { runner: mockRunner })
    expect(res1).toEqual({
      text: 'The heavy session consumed the block, but the reset is safe.',
      model: 'gemini-3.8-flash-low',
    })
    expect(callCount).toBe(1)
    expect(recordedCmd).toBe('agy')
    expect(recordedArgs).toContain('--model')
    expect(recordedArgs).toContain('gemini-3.8-flash-low')
    expect(recordedArgs).toContain('--output-format')
    expect(recordedArgs).toContain('text')
    expect(recordedTimeout).toBe(20000)

    // second call with exact same state must return cached result and not call runner
    const res2 = await getTakeaway(state, { runner: mockRunner })
    expect(res2).toEqual(res1)
    expect(callCount).toBe(1)

    // updated state with different sampledAt must call runner again
    const updatedState = {
      ...state,
      fiveHour: { ...state.fiveHour!, sampledAt: state.fiveHour!.sampledAt + 300 },
    }
    const res3 = await getTakeaway(updatedState, { runner: mockRunner })
    expect(res3).toEqual(res1)
    expect(callCount).toBe(2)
  })

  it('returns null on runner failure (non-zero exit, timeout, no agy)', async () => {
    resetTakeawayCache()
    const state = await fixtureState()

    const failingRunner: CommandRunner = async () => null
    const res = await getTakeaway(state, { runner: failingRunner })
    expect(res).toEqual({ text: null, model: null })
  })

  it('returns null when options.enabled is false', async () => {
    resetTakeawayCache()
    const state = await fixtureState()

    let called = false
    const runner: CommandRunner = async () => {
      called = true
      return { stdout: 'hello', stderr: '' }
    }
    const res = await getTakeaway(state, { runner, enabled: false })
    expect(res).toEqual({ text: null, model: null })
    expect(called).toBe(false)
  })
})

describe('parseOptions --no-takeaway', () => {
  it('defaults to takeaway enabled and disables with --no-takeaway', () => {
    expect(parseOptions([]).takeaway).toBe(true)
    expect(parseOptions(['--no-takeaway']).takeaway).toBe(false)
  })
})

describe('GET /api/takeaway endpoint', () => {
  it('returns takeaway JSON payload', async () => {
    resetTakeawayCache()
    const app = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      ccbrowse: null,
      recordLook: false,
    })

    // with a mock runner injected through options if possible, or by pre-populating the cache
    const state = await buildState({
      home: FIXTURE_HOME,
      now: NOW,
      ccbrowse: null,
      recordLook: false,
    })
    const runner: CommandRunner = async () => ({
      stdout: 'Short block run, reset is safe.',
      stderr: '',
    })
    // populate cache for this state
    await getTakeaway(state, { runner })

    const res = await app.request('/api/takeaway')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { text: string | null; model: string | null }
    expect(json).toEqual({
      text: 'Short block run, reset is safe.',
      model: 'gemini-3.8-flash-low',
    })
  })

  it('returns null when takeaway is disabled via createApp config', async () => {
    const app = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      ccbrowse: null,
      recordLook: false,
      takeaway: false,
    })

    const res = await app.request('/api/takeaway')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { text: string | null; model: string | null }
    expect(json).toEqual({ text: null, model: null })
  })
})
