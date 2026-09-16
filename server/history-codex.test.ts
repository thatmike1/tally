// tests for `GET /api/history/codex`, over synthetic rollouts and a synthetic
// reader history written into a temp home. the fixtures follow
// `codex-sessions.test.ts`; every expected figure below is hand-computed from
// the Codex rate card and the OpenAI list-price table.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCodexHistory, startOfMonth } from './history-codex'
import { dayKey } from './time'

const WEEK = 7 * 86_400
/** the older window's reset; the newer window's reset is a week later */
const RESET_1 = 2_000_000_000
const RESET_2 = RESET_1 + WEEK
const FROM_1 = RESET_1 - WEEK
const NOW = RESET_1 + 3600

const iso = (t: number) => new Date(t * 1000).toISOString()

function meta(id: string, t: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: iso(t),
    type: 'session_meta',
    payload: { id, session_id: id, cwd: '/home/m/git/tally', originator: 't3code_desktop', model_provider: 'openai', ...extra },
  })
}

function turn(model: string, t: number) {
  return JSON.stringify({ timestamp: iso(t), type: 'turn_context', payload: { model } })
}

function usage(thread: string, response: string, t: number, tokens: { input: number; cached?: number; output?: number }) {
  return JSON.stringify({
    timestamp: iso(t),
    type: 'token_usage_record',
    payload: {
      thread_id: thread,
      response_id: response,
      usage: { input_tokens: tokens.input, cached_input_tokens: tokens.cached ?? 0, output_tokens: tokens.output ?? 0 },
    },
  })
}

function reading(t: number, pct: number, resetsAt: number) {
  return JSON.stringify({
    timestamp: iso(t),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10_080, resets_at: resetsAt }, secondary: null },
    },
  })
}

/** a temp home holding `~/.codex/sessions/...` rollouts and `~/.cache/tally/codex-usage.jsonl` */
function fakeHome(files: Record<string, string[]>, readerHistory: object[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'tally-codex-history-'))
  const sessions = join(home, '.codex', 'sessions', '2033', '05', '11')
  mkdirSync(sessions, { recursive: true })
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(sessions, `rollout-${name}.jsonl`), `${lines.join('\n')}\n`)
  }
  mkdirSync(join(home, '.cache', 'tally'), { recursive: true })
  writeFileSync(
    join(home, '.cache', 'tally', 'codex-usage.jsonl'),
    readerHistory.map((row) => JSON.stringify(row)).join('\n') + (readerHistory.length ? '\n' : ''),
  )
  return home
}

/**
 * two windows: an older closed one with a subagent and a duplicated file, and a
 * current one carrying a model the price table does not know.
 */
function twoWindowHome(): string {
  const parent = [
    meta('a', FROM_1, {}),
    turn('gpt-5.6-sol', FROM_1),
    reading(FROM_1 + 100, 10, RESET_1),
    // 1M uncached input: 100 credits at Sol's 100/M, $4.00 at list
    usage('a', 'r1', FROM_1 + 200, { input: 1_000_000 }),
    // 1M cached + 100k output: 10 + 50 credits, $0.40 + $2.00 at list
    usage('a', 'r2', FROM_1 + 900, { input: 0, cached: 1_000_000, output: 100_000 }),
    reading(FROM_1 + 1000, 30, RESET_1),
    // after the window's last reading, so no reading covers it
    usage('a', 'late', FROM_1 + 2000, { input: 9_000_000 }),
  ]
  const child = [
    meta('c', FROM_1 + 400, { session_id: 'a', parent_thread_id: 'a' }),
    turn('gpt-5.6-sol', FROM_1 + 400),
    // the fork copied its parent's history; that call belongs to the parent's file
    usage('a', 'r1', FROM_1 + 200, { input: 1_000_000 }),
    // 500k input: 50 credits, $2.00 at list
    usage('c', 'c1', FROM_1 + 500, { input: 500_000 }),
  ]
  // the same thread seen twice on disk; its calls must still count once
  const copy = [meta('a', FROM_1, {}), turn('gpt-5.6-sol', FROM_1), usage('a', 'r1', FROM_1 + 200, { input: 1_000_000 })]
  const current = [
    meta('b', RESET_1 + 50, {}),
    turn('gpt-5.6-sol', RESET_1 + 50),
    reading(RESET_1 + 100, 5, RESET_2),
    usage('b', 's1', RESET_1 + 200, { input: 1_000_000 }),
    // no list-price row: credits still count at the rate card's fallback, dollars do not
    turn('codex-auto-review', RESET_1 + 250),
    usage('b', 'u1', RESET_1 + 300, { input: 1_000_000 }),
    reading(RESET_1 + 600, 25, RESET_2),
  ]
  return fakeHome(
    { a: parent, c: child, 'a-copy': copy, b: current },
    // the reader's own reading of the current window, its reset jittered by 30 s
    [{ sampledAt: RESET_1 + 400, usedPercent: 20, resetsAt: RESET_2 + 30, windowDurationMins: 10_080 }],
  )
}

describe('buildCodexHistory', () => {
  it('reports one window per weekly reset, oldest first, with the reader merged in', async () => {
    const history = await buildCodexHistory({ home: twoWindowHome(), now: NOW })
    expect(history.windows.map((window) => window.resetsAt)).toEqual([RESET_1, RESET_2])
    expect(history.windows[0]).toMatchObject({ start: FROM_1, end: RESET_1, partial: false, from: FROM_1 + 100, to: FROM_1 + 1000 })
    // the reader's jittered reset joined the rollouts' window rather than opening its own
    expect(history.windows[1]).toMatchObject({ start: RESET_1, end: NOW, partial: true, from: RESET_1 + 100, to: RESET_1 + 600 })
    expect(history.sources.usage).toContain('codex-usage.jsonl')
  })

  it('counts a forked or duplicated call once and leaves calls outside the readings out', async () => {
    const [closed] = (await buildCodexHistory({ home: twoWindowHome(), now: NOW })).windows
    // r1, r2 and the subagent's c1; the copied r1 and the `late` call are not in
    expect(closed).toMatchObject({ calls: 3, startPct: 10, endPct: 30, delta: 20 })
    expect(closed!.byModel['gpt-5.6-sol']).toMatchObject({ calls: 3, input: 1_500_000, cached: 1_000_000, output: 100_000 })
  })

  it('computes credits per percent off the rate card and cost off the list price', async () => {
    const [closed] = (await buildCodexHistory({ home: twoWindowHome(), now: NOW })).windows
    // 100 + (10 + 50) + 50 credits over a 20-point delta
    expect(closed!.credits).toBeCloseTo(210)
    expect(closed!.creditsPerPercent).toBeCloseTo(10.5)
    // $4.00 + ($0.40 + $2.00) + $2.00 at Sol's list price
    expect(closed!.costUsd).toBeCloseTo(8.4)
    expect(closed!.byModel['gpt-5.6-sol']!.costUsd).toBeCloseTo(8.4)
    expect(closed!.unknownModels).toEqual([])
  })

  it('flags an unknown model, drops the window cost and keeps its credits', async () => {
    const current = (await buildCodexHistory({ home: twoWindowHome(), now: NOW })).windows[1]!
    expect(current.unknownModels).toEqual(['codex-auto-review'])
    expect(current.costUsd).toBeNull()
    expect(current.byModel['codex-auto-review']).toMatchObject({ calls: 1, credits: 100, costUsd: null })
    // the priced half of the window still has its own dollars
    expect(current.byModel['gpt-5.6-sol']!.costUsd).toBeCloseTo(4)
    // credits are the rate card's, which prices an unknown model like Sol
    expect(current.credits).toBeCloseTo(200)
    expect(current.creditsPerPercent).toBeCloseTo(10)
  })

  it('keeps the known models\' dollars in a priced subtotal beside the null total', async () => {
    const [closed, current] = (await buildCodexHistory({ home: twoWindowHome(), now: NOW })).windows
    // every model known: the subtotal is the total
    expect(closed!.pricedCostUsd).toBeCloseTo(8.4)
    expect(closed!.pricedCostUsd).toBeCloseTo(closed!.costUsd!)
    // only the Sol half of the window can be priced, and it is still reported
    expect(current!.costUsd).toBeNull()
    expect(current!.pricedCostUsd).toBeCloseTo(4)
  })

  it('has a priced month subtotal even while an unknown model nulls the month cost', async () => {
    const { subValue } = await buildCodexHistory({ home: twoWindowHome(), now: NOW })
    expect(subValue.monthCostUsd).toBeNull()
    // window one's $8.40, window two's $4.00 and the `late` call's 9M Sol input at $4/M
    expect(subValue.pricedMonthCostUsd).toBeCloseTo(8.4 + 4 + 36)
  })

  it('has no month cost while an unknown model is in the month, and names it', async () => {
    const history = await buildCodexHistory({ home: twoWindowHome(), now: NOW })
    expect(history.subValue).toMatchObject({ monthCostUsd: null, planUsd: 100, unknownModels: ['codex-auto-review'] })
    expect(history.subValue.monthStart).toBe(startOfMonth(NOW))
    expect(dayKey(history.subValue.monthStart)).toMatch(/-01$/)
  })

  it('publishes the price table with its source and read date', async () => {
    const history = await buildCodexHistory({ home: twoWindowHome(), now: NOW })
    expect(history.prices.source).toMatch(/^https:\/\//)
    expect(history.prices.readAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(history.prices.models['gpt-5.6-sol']).toMatchObject({ input: 4 })
  })

  it('prices the month when every model in it is known', async () => {
    const home = fakeHome({
      a: [
        meta('a', RESET_1 + 50, {}),
        turn('gpt-5.6-luna', RESET_1 + 50),
        reading(RESET_1 + 100, 1, RESET_2),
        // 2M input at Luna: $0.20/M
        usage('a', 'r1', RESET_1 + 200, { input: 2_000_000 }),
        reading(RESET_1 + 300, 3, RESET_2),
      ],
    })
    const history = await buildCodexHistory({ home, now: NOW })
    expect(history.subValue.monthCostUsd).toBeCloseTo(0.4)
    expect(history.subValue.unknownModels).toEqual([])
  })

  it('leaves a thread routed to another provider off the meter entirely', async () => {
    const home = fakeHome({
      a: [
        meta('a', RESET_1 + 50, {}),
        turn('gpt-5.6-sol', RESET_1 + 50),
        reading(RESET_1 + 100, 1, RESET_2),
        usage('a', 'r1', RESET_1 + 200, { input: 1_000_000 }),
        reading(RESET_1 + 300, 3, RESET_2),
      ],
      routed: [
        meta('x', RESET_1 + 50, { model_provider: 'AgentRouter' }),
        turn('gpt-5.6-sol', RESET_1 + 50),
        reading(RESET_1 + 150, 90, RESET_2),
        usage('x', 'x1', RESET_1 + 250, { input: 50_000_000 }),
      ],
    })
    const [window] = (await buildCodexHistory({ home, now: NOW })).windows
    expect(window).toMatchObject({ calls: 1, startPct: 1, endPct: 3, delta: 2 })
    expect(window!.credits).toBeCloseTo(100)
  })

  it('has no delta and no calibration from a single reading', async () => {
    const home = fakeHome({
      a: [meta('a', RESET_1 + 50, {}), turn('gpt-5.6-sol', RESET_1 + 50), reading(RESET_1 + 100, 7, RESET_2), usage('a', 'r1', RESET_1 + 100, { input: 1_000_000 })],
    })
    const [window] = (await buildCodexHistory({ home, now: NOW })).windows
    expect(window).toMatchObject({ delta: null, creditsPerPercent: null, from: RESET_1 + 100, to: RESET_1 + 100 })
  })

  it('ignores a rollout reading that lags below the window peak', async () => {
    const home = fakeHome({
      a: [
        meta('a', RESET_1 + 50, {}),
        turn('gpt-5.6-sol', RESET_1 + 50),
        reading(RESET_1 + 100, 4, RESET_2),
        reading(RESET_1 + 300, 9, RESET_2),
        // written late by a rollout holding a stale number; it would fake a fall
        reading(RESET_1 + 500, 6, RESET_2),
      ],
    })
    const [window] = (await buildCodexHistory({ home, now: NOW })).windows
    expect(window).toMatchObject({ to: RESET_1 + 300, endPct: 9, delta: 5 })
  })

  it('answers with nothing rather than failing when there is no Codex data at all', async () => {
    const history = await buildCodexHistory({ home: mkdtempSync(join(tmpdir(), 'tally-codex-empty-')), now: NOW })
    expect(history.windows).toEqual([])
    expect(history.subValue).toMatchObject({ monthCostUsd: 0, unknownModels: [] })
  })
})

describe('a window older than per-call token records', () => {
  it('says not measured rather than zero when the rollouts carry readings but no calls', async () => {
    const home = fakeHome({
      old: [
        meta('o', RESET_1 + 50, {}),
        turn('gpt-5.6-sol', RESET_1 + 50),
        reading(RESET_1 + 100, 4, RESET_2),
        reading(RESET_1 + 300, 14, RESET_2),
      ],
    })
    const [window] = (await buildCodexHistory({ home, now: NOW })).windows
    expect(window).toMatchObject({ delta: 10, calls: 0, credits: 0, creditsPerPercent: null, costUsd: null })
  })
})
