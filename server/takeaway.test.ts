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
  createTakeawayRefresher,
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
    lastLookedPath: lookPath,
    recordLook: false,
  })
}

describe('buildTakeawaySummary and prompt', () => {
  it('formats compact summary with 5h, projection, verdicts, and sessions', async () => {
    const state = await fixtureState()
    state.block = { ...state.block!, projection: { pace: 0.02, pctAtReset: 100, hitsHundredAt: NOW + 1500, ready: true } }
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

describe('takeawayCacheKey and createTakeawayRefresher', () => {
  it('keys cache on fiveHour.sampledAt and block.to', async () => {
    const state = await fixtureState()
    const key = takeawayCacheKey(state)
    expect(key).toBe(`${state.fiveHour!.sampledAt}:${state.block!.to}`)

    const emptyState = { ...state, fiveHour: null }
    expect(takeawayCacheKey(emptyState)).toBeNull()
  })

  it('runs agy with gemini-3.8-flash-low and a 45 s timeout, and skips an unchanged block', async () => {
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
    const refresher = createTakeawayRefresher({ runner: mockRunner })
    expect(refresher.current()).toEqual({ text: null, model: null })

    await refresher.refresh(state)
    expect(refresher.current()).toEqual({
      text: 'The heavy session consumed the block, but the reset is safe.',
      model: 'gemini-3.8-flash-low',
    })
    expect(callCount).toBe(1)
    expect(recordedCmd).toBe('agy')
    expect(recordedArgs).toContain('--model')
    expect(recordedArgs).toContain('gemini-3.8-flash-low')
    expect(recordedArgs).toContain('--output-format')
    expect(recordedArgs).toContain('text')
    expect(recordedTimeout).toBe(45000)

    // the same block state already has text, so the runner is not called again
    await refresher.refresh(state)
    expect(callCount).toBe(1)

    // a new sample moves the key and runs again
    const updatedState = {
      ...state,
      fiveHour: { ...state.fiveHour!, sampledAt: state.fiveHour!.sampledAt + 300 },
    }
    await refresher.refresh(updatedState)
    expect(callCount).toBe(2)
  })

  it('keeps the last good text through a failure and retries the same block next tick', async () => {
    const state = await fixtureState()
    const outputs: Array<{ stdout: string; stderr: string } | null> = [
      { stdout: 'First good line.', stderr: '' },
      null,
      { stdout: 'Second good line.', stderr: '' },
    ]
    let callCount = 0
    const runner: CommandRunner = async () => outputs[callCount++] ?? null
    const refresher = createTakeawayRefresher({ runner })

    await refresher.refresh(state)
    const next = { ...state, fiveHour: { ...state.fiveHour!, sampledAt: state.fiveHour!.sampledAt + 300 } }

    // a timed-out run leaves the previous text in place
    await refresher.refresh(next)
    expect(refresher.current().text).toBe('First good line.')

    // and the failed block is not cached, so the next tick tries it again
    await refresher.refresh(next)
    expect(callCount).toBe(3)
    expect(refresher.current().text).toBe('Second good line.')
  })

  it('runs one call at a time', async () => {
    const state = await fixtureState()
    let callCount = 0
    let release: () => void = () => {}
    const runner: CommandRunner = async () => {
      callCount++
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { stdout: 'Slow line.', stderr: '' }
    }
    const refresher = createTakeawayRefresher({ runner })

    const first = refresher.refresh(state)
    const next = { ...state, fiveHour: { ...state.fiveHour!, sampledAt: state.fiveHour!.sampledAt + 300 } }
    const second = refresher.refresh(next)
    release()
    await Promise.all([first, second])
    expect(callCount).toBe(1)
    expect(refresher.current().text).toBe('Slow line.')
  })
})

describe('parseOptions --no-takeaway', () => {
  it('defaults to takeaway enabled and disables with --no-takeaway', () => {
    expect(parseOptions([]).takeaway).toBe(true)
    expect(parseOptions(['--no-takeaway']).takeaway).toBe(false)
  })
})

describe('/api/takeaway endpoint', () => {
  it('serves the refresher text without running the model', async () => {
    let callCount = 0
    const runner: CommandRunner = async () => {
      callCount++
      return { stdout: 'Short block run, reset is safe.', stderr: '' }
    }
    const refresher = createTakeawayRefresher({ runner })
    const app = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
      takeaway: refresher,
    })

    // before the first tick the route answers null straight away
    const empty = await app.request('/api/takeaway')
    expect(await empty.json()).toEqual({ text: null, model: null })
    expect(callCount).toBe(0)

    const state = await buildState({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
    })
    await refresher.refresh(state)

    const res = await app.request('/api/takeaway')
    expect(callCount).toBe(1)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { text: string | null; model: string | null }
    expect(json).toEqual({
      text: 'Short block run, reset is safe.',
      model: 'gemini-3.8-flash-low',
    })
  })

  it('runs the model only when POST explicitly requests a fresh takeaway', async () => {
    let callCount = 0
    const runner: CommandRunner = async () => {
      callCount++
      return { stdout: 'Visible page requested this line.', stderr: '' }
    }
    const refresher = createTakeawayRefresher({ runner })
    const app = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
      takeaway: refresher,
    })

    const read = await app.request('/api/takeaway')
    expect(callCount).toBe(0)
    expect(await read.json()).toEqual({ text: null, model: null })

    const generated = await app.request('/api/takeaway', { method: 'POST' })
    expect(callCount).toBe(1)
    expect(await generated.json()).toEqual({
      text: 'Visible page requested this line.',
      model: 'gemini-3.8-flash-low',
    })

    // the unchanged state is cached even if focus/visibility events race
    await app.request('/api/takeaway', { method: 'POST' })
    expect(callCount).toBe(1)
  })

  it('returns null when takeaway is disabled via createApp config', async () => {
    const app = createApp({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
      takeaway: null,
    })

    const res = await app.request('/api/takeaway')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { text: string | null; model: string | null }
    expect(json).toEqual({ text: null, model: null })
  })
})
