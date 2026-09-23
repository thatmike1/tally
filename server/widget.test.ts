// tests for rendering and writing the T3 sidebar widget.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseOptions } from './main'
import { buildState } from './state'
import { formatHm } from './time'
import {
  computeWidgetState,
  defaultWidgetsDir,
  renderWidget,
  resetWidgetCache,
  removeWidget,
  writeWidget,
} from './widget'
import { UsageTally } from './usage'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
const NOW = 1789138000

async function fixtureState(lastLooked?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-widget-test-'))
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

describe('renderWidget', () => {
  it('renders expected metadata and meter rows from fixture state', async () => {
    const fixture = await fixtureState()
    // the fixture block spans ten minutes, too short to project from
    expect(renderWidget(fixture).rows[1]?.label).toMatch(/·  no pace yet$/)
    const state = {
      ...fixture,
      block: { ...fixture.block!, projection: { pace: 0.02, pctAtReset: 100, hitsHundredAt: NOW + 1500, ready: true } },
    }
    const widget = renderWidget(state)

    expect(widget.icon).toBe('activity')
    expect(widget.order).toBe(15)
    expect(widget.label).toBe('70%')
    // the fixture's projection hits 100 before reset, which is row text, not an orange sidebar
    expect(widget.state).toBe('ok')

    const resetTime = formatHm(state.fiveHour!.resetsAt)
    const hitsTime = formatHm(state.block!.projection.hitsHundredAt!)
    expect(widget.tooltip).toBe(`100% at ${hitsTime} · resets ${resetTime}`)

    expect(widget.rows.map((r) => r.label)).toEqual([
      'Codex · unavailable',
      `5h  70%  ·  resets ${resetTime}  ·  100% at ${hitsTime}`,
      'week  76%  ·  a full day fits',
      'Fable  87%  ·  one light day left',
    ])
  })

  it('says expired in place of the reset clock when the sample is past its reset', async () => {
    const state = await fixtureState()
    const expired = { ...state, fiveHour: { ...state.fiveHour!, expired: true } }
    expect(renderWidget(expired).rows[1]?.label).toMatch(/^5h {2}70% {2}· {2}expired {2}· {2}/)
  })

  it('leaves block and Fable sessions to the page', async () => {
    const state = await fixtureState('1789000000')
    // sessions in the block and in the week must not reach the widget rows
    state.split = {
      from: NOW - 3600,
      to: NOW,
      delta: 10,
      totalCost: 1.5,
      costBeforeFirstSample: 0,
      costAfterLastSample: 0,
      usage: new UsageTally().summary(),
      sessions: [
        {
          sessionId: 'session-1',
          project: 'proj',
          title: 'a very long task title that exceeds thirty-six characters limit comfortably',
          cost: 1.0,
          share: 0.452,
          points: 4.5,
          requests: 5,
          subagents: 0,
          start: NOW - 3000,
          end: NOW - 100,
          tokens: 1000,
          unpriced: false,
          kind: 'claude',
          live: false,
          color: '#d94f2a',
          fableShare: null,
          fablePoints: null,
          models: [],
          effort: [],
          buckets: { in: 0, cw1h: 0, cw5m: 0, cr: 0, out: 0 },
          shortTitle: null,
        },
        {
          sessionId: 'session-2',
          project: 'proj',
          title: 'short title',
          cost: 0.5,
          share: 0.25,
          points: 2.5,
          requests: 3,
          subagents: 0,
          start: NOW - 2000,
          end: NOW - 200,
          tokens: 500,
          unpriced: false,
          kind: 'claude',
          live: false,
          color: '#b5836a',
          fableShare: null,
          fablePoints: null,
          models: [],
          effort: [],
          buckets: { in: 0, cw1h: 0, cw5m: 0, cr: 0, out: 0 },
          shortTitle: null,
        },
      ],
    }

    const widget = renderWidget(state)
    const labels = widget.rows.map((r) => r.label)

    expect(state.week.fable?.sessions.length).toBeGreaterThan(0)
    expect(labels).toHaveLength(4)
    expect(labels.some((l) => l.includes('short title') || l.includes('fixture session'))).toBe(false)
  })

  it('sets attention state only for an expired or stale sampler, never for a projection', async () => {
    const base = await fixtureState()

    // normal ok state when pace is healthy and fresh
    const okState = {
      ...base,
      fiveHour: { ...base.fiveHour!, expired: false, ageSeconds: 120 },
      block: {
        ...base.block!,
        projection: { pace: 0.001, pctAtReset: 80, hitsHundredAt: null, ready: true },
      },
    }
    expect(computeWidgetState(okState)).toBe('ok')

    // projection hits 100
    const overState = {
      ...okState,
      block: {
        ...okState.block,
        projection: { pace: 0.01, pctAtReset: 100, hitsHundredAt: NOW + 1000, ready: true },
      },
    }
    expect(computeWidgetState(overState)).toBe('ok')

    // sampler expired
    const expiredState = {
      ...okState,
      fiveHour: { ...okState.fiveHour, expired: true },
    }
    expect(computeWidgetState(expiredState)).toBe('attention')

    // sampler stale (> 900s)
    const staleState = {
      ...okState,
      fiveHour: { ...okState.fiveHour, ageSeconds: 901 },
    }
    expect(computeWidgetState(staleState)).toBe('attention')
  })
})

describe('writeWidget and removeWidget', () => {
  it('writes tally.json atomically and skips writes when body is unchanged', async () => {
    resetWidgetCache()
    const dir = mkdtempSync(join(tmpdir(), 'tally-widget-write-'))
    const target = join(dir, 'tally.json')
    const state = await fixtureState()

    // first write creates file
    writeWidget(state, dir)
    expect(existsSync(target)).toBe(true)
    const firstContent = readFileSync(target, 'utf8')
    const parsed = JSON.parse(firstContent)
    expect(parsed.icon).toBe('activity')
    expect(parsed.order).toBe(15)

    // wind back mtime to test if rewrite occurs
    utimesSync(target, 1000, 1000)
    const statBefore = statSync(target)

    // second write with identical state should be skipped
    writeWidget(state, dir)
    const statAfter = statSync(target)
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)

    // write with updated state should rewrite file
    const updatedState = {
      ...state,
      fiveHour: { ...state.fiveHour!, pct: 85 },
    }
    writeWidget(updatedState, dir)
    const statUpdated = statSync(target)
    expect(statUpdated.mtimeMs).toBeGreaterThan(1000 * 1000)
    const updatedContent = JSON.parse(readFileSync(target, 'utf8'))
    expect(updatedContent.label).toBe('85%')

    // clean removal deletes file and clears cache
    removeWidget(dir)
    expect(existsSync(target)).toBe(false)
  })

  it('does not throw when write or remove fails', async () => {
    // using an invalid path that cannot be created or written
    const invalidDir = '/dev/null/impossible-dir'
    expect(() => writeWidget({} as never, invalidDir)).not.toThrow()
    expect(() => removeWidget(invalidDir)).not.toThrow()
  })
})

describe('defaultWidgetsDir', () => {
  it('is null on a machine with no T3 Code, so nothing is created under ~/.t3', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-no-t3-'))
    expect(defaultWidgetsDir({}, home)).toBeNull()
    expect(() => writeWidget({} as never, null)).not.toThrow()
    expect(existsSync(join(home, '.t3'))).toBe(false)
  })

  it('takes the directory T3_WIDGETS_DIR names even without a T3 tree', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-no-t3-'))
    expect(defaultWidgetsDir({ T3_WIDGETS_DIR: '/tmp/forced' }, home)).toBe('/tmp/forced')
  })

  it('is the widgets directory once T3 has a userdata tree', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-t3-'))
    mkdirSync(join(home, '.t3', 'userdata'), { recursive: true })
    expect(defaultWidgetsDir({}, home)).toBe(join(home, '.t3', 'userdata', 'widgets'))
  })
})

describe('parseOptions', () => {
  it('parses --no-widget flag', () => {
    expect(parseOptions([]).widget).toBe(true)
    expect(parseOptions(['--no-widget']).widget).toBe(false)
  })
})
