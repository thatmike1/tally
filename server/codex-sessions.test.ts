// tests for reading Codex rollouts and splitting the Codex weekly meter across threads.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexCredits,
  codexRate,
  codexSessionDetail,
  parseRolloutLines,
  pointSteps,
  cutRollout,
  scanRollouts,
  splitCodexWeek,
  threadSince,
  type CodexRollout,
} from './codex-sessions'

const RESET = 2_000_000_000
const FROM = RESET - 7 * 86_400

const iso = (t: number) => new Date(t * 1000).toISOString()

function meta(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ timestamp: iso(FROM), type: 'session_meta', payload: { id, session_id: id, cwd: '/home/m/git/tally', originator: 't3code_desktop', model_provider: 'openai', ...extra } })
}

function turn(model: string, t = FROM) {
  return JSON.stringify({ timestamp: iso(t), type: 'turn_context', payload: { model } })
}

function usage(thread: string, response: string, t: number, tokens: { input: number; cached?: number; output: number }) {
  return JSON.stringify({
    timestamp: iso(t),
    type: 'token_usage_record',
    payload: { thread_id: thread, response_id: response, usage: { input_tokens: tokens.input, cached_input_tokens: tokens.cached ?? 0, output_tokens: tokens.output } },
  })
}

function reading(t: number, pct: number, resetsAt = RESET) {
  return JSON.stringify({
    timestamp: iso(t),
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10_080, resets_at: resetsAt }, secondary: null } },
  })
}

function user(text: string, t = FROM) {
  return JSON.stringify({ timestamp: iso(t), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
}

/** a rollout whose every call costs exactly `credits` at Sol rates (100 per million input) */
function rollout(id: string, calls: [response: string, t: number, credits: number][], extra: Record<string, unknown> = {}): CodexRollout {
  return parseRolloutLines(`/r/${id}.jsonl`, [
    meta(id, extra),
    turn('gpt-5.6-sol'),
    ...calls.map(([response, t, credits]) => usage(id, response, t, { input: credits * 10_000, output: 0 })),
  ])!
}

describe('codexRate', () => {
  it('prices a dated or spaced model name by its rate-card row', () => {
    expect(codexRate('GPT-6 Astra')).toMatchObject({ priced: true, rate: { input: 250 } })
    expect(codexRate('gpt-5.6-luna-2026-08-01')).toMatchObject({ priced: true, rate: { output: 30 } })
  })

  it('prices an unknown model like Sol and flags it', () => {
    expect(codexRate('gpt-7-nova')).toMatchObject({ priced: false, rate: { input: 100 } })
  })

  it('charges cached input at its own rate', () => {
    expect(codexCredits('gpt-6-astra', 1_000_000, 2_000_000, 100_000).credits).toBeCloseTo(250 + 50 + 125)
  })
})

describe('parseRolloutLines', () => {
  it('reads calls with the model in force, the meter readings and the first typed prompt', () => {
    const parsed = parseRolloutLines('/r/a.jsonl', [
      meta('a'),
      user('<environment_context>cwd</environment_context>'),
      user('# AGENTS.md instructions'),
      user('fix the   left align issue'),
      turn('gpt-6-astra'),
      usage('a', 'resp_1', FROM + 60, { input: 1_000_000, cached: 400_000, output: 10_000 }),
      reading(FROM + 61, 3),
      turn('gpt-5.6-luna', FROM + 100),
      usage('a', 'resp_2', FROM + 120, { input: 1_000_000, output: 0 }),
    ])!
    expect(parsed).toMatchObject({ id: 'a', rootId: 'a', subagent: false, openai: true, firstPrompt: 'fix the left align issue', lastT: FROM + 120 })
    expect(parsed.calls.map((call) => [call.model, call.input, call.cached])).toEqual([
      ['gpt-6-astra', 600_000, 400_000],
      ['gpt-5.6-luna', 1_000_000, 0],
    ])
    expect(parsed.calls[0]!.credits).toBeCloseTo(0.6 * 250 + 0.4 * 25 + 0.01 * 1250)
    expect(parsed.readings).toEqual([{ t: FROM + 61, pct: 3, resetsAt: RESET }])
  })

  it('folds a subagent into its root and leaves the copied parent history to the parent', () => {
    const parsed = parseRolloutLines('/r/child.jsonl', [
      meta('child', { session_id: 'root', parent_thread_id: 'root' }),
      turn('gpt-5.6-sol'),
      usage('root', 'resp_parent', FROM + 10, { input: 100, output: 0 }),
      usage('child', 'resp_child', FROM + 20, { input: 100, output: 0 }),
    ])!
    expect(parsed).toMatchObject({ id: 'child', rootId: 'root', subagent: true })
    expect(parsed.calls.map((call) => call.responseId)).toEqual(['resp_child'])
  })

  it('marks a thread routed to another provider', () => {
    expect(parseRolloutLines('/r/x.jsonl', [meta('x', { model_provider: 'AgentRouter' })])?.openai).toBe(false)
  })

  it('ignores a file with no session header', () => {
    expect(parseRolloutLines('/r/y.jsonl', [turn('gpt-5.6-sol')])).toBeNull()
  })
})

describe('scanRollouts', () => {
  it('walks the dated folders and skips files not written since the window opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-codex-sessions-'))
    const dir = join(root, '2026', '09', '15')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'rollout-2026-09-15T10-00-00-a.jsonl'), `${meta('a')}\n${turn('gpt-5.6-sol')}\n${usage('a', 'r1', FROM + 5, { input: 10, output: 1 })}\n`)
    writeFileSync(join(dir, 'notes.txt'), 'not a rollout')
    expect((await scanRollouts(0, root)).map((r) => r.id)).toEqual(['a'])
    expect(await scanRollouts(Date.now() / 1000 + 3600, root)).toEqual([])
  })
})

describe('cutRollout', () => {
  it('drops what was written after the cut and moves the last write back to it', () => {
    const full = rollout('a', [['r1', FROM + 100, 10], ['r2', FROM + 400, 7]])
    full.lastT = FROM + 900
    const cut = cutRollout(full, FROM + 500)
    expect(cut.calls.map((call) => call.responseId)).toEqual(['r1', 'r2'])
    expect(cut.lastT).toBe(FROM + 400)
    expect(cutRollout(full, FROM + 50)).toMatchObject({ calls: [], lastT: null })
    expect(cutRollout(full, FROM + 1000)).toBe(full)
  })
})

/** credits at Sol rates: 100 per million uncached input, so 10k input tokens is one credit */
const sol = (credits: number) => ({ input: credits * 10_000, output: 0 })

const LEAD = 'lead-0001'

/**
 * a lead thread with two subagents under it: Feynman, a forked thread_spawn
 * that copied the lead's history, and a guardian review. written into a dated
 * folder, backdated to `mtime` when given.
 */
function writeThread(root: string, day: [string, string, string], mtime?: number) {
  const feynman = 'feyn-0002'
  const guardian = 'guard-0003'
  const dir = join(root, ...day)
  mkdirSync(dir, { recursive: true })
  const files: [string, string[]][] = [
    [LEAD, [meta(LEAD), user('explode the codex thread'), turn('gpt-5.6-sol'), usage(LEAD, 'l1', FROM + 100, sol(10)), usage(LEAD, 'l2', FROM + 500, sol(4))]],
    [
      feynman,
      [
        meta(feynman, { session_id: LEAD, parent_thread_id: LEAD, source: { subagent: { thread_spawn: { parent_thread_id: LEAD, agent_nickname: 'Feynman', agent_role: 'explorer' } } } }),
        // the fork carries the lead's session_meta and history before its own
        meta(LEAD),
        turn('gpt-5.6-sol'),
        usage(LEAD, 'l1', FROM + 100, sol(10)),
        usage(feynman, 'f1', FROM + 200, sol(3)),
        usage(feynman, 'f2', FROM + 300, sol(2)),
      ],
    ],
    [
      guardian,
      [
        meta(guardian, { session_id: LEAD, parent_thread_id: LEAD, source: { subagent: { other: 'guardian' } } }),
        turn('gpt-5.6-luna'),
        // Luna prices 5 per million uncached input: one credit
        usage(guardian, 'g1', FROM + 600, { input: 200_000, output: 0 }),
      ],
    ],
  ]
  for (const [id, lines] of files) {
    const path = join(dir, `rollout-${day.join('-')}T10-00-00-${id}.jsonl`)
    writeFileSync(path, `${lines.join('\n')}\n`)
    if (mtime !== undefined) utimesSync(path, mtime, mtime)
  }
}

describe('codexSessionDetail', () => {
  it('lays a thread out as its lead and one labelled lane per subagent, the forked history counted once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-codex-detail-'))
    writeThread(root, ['2026', '09', '15'])
    const detail = (await codexSessionDetail(LEAD, { root, now: FROM + 900 }))!
    expect(detail).toMatchObject({ sessionId: `codex:${LEAD}`, title: 'explode the codex thread', project: '/home/m/git/tally', unit: 'credits', live: false })
    expect(detail.parent).toMatchObject({ label: 'main', agent: false })
    expect(detail.parent.requests.map((r) => r.t)).toEqual([FROM + 100, FROM + 500])
    expect(detail.parent.cost).toBeCloseTo(14)
    expect(detail.subagents.map((lane) => [lane.label, lane.agent, lane.requests.length])).toEqual([
      ['Feynman · explorer', true, 2],
      ['guardian', true, 1],
    ])
    // the copied `l1` stays on the lead; Feynman pays only for its own two calls
    expect(detail.subagents[0]!.cost).toBeCloseTo(5)
    expect(detail.subagents[1]!.cost).toBeCloseTo(1)
    const lanes = [detail.parent, ...detail.subagents]
    expect(detail.cost).toBeCloseTo(lanes.reduce((sum, lane) => sum + lane.cost, 0))
    expect(detail.cost).toBeCloseTo(20)
    expect(detail.tokens).toBe(lanes.reduce((sum, lane) => sum + lane.tokens, 0))
    expect(detail.requests).toBe(5)
    expect([detail.start, detail.end]).toEqual([FROM + 100, FROM + 600])
  })

  it('is null for a root id no rollout carries, a subagent id included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-codex-detail-'))
    writeThread(root, ['2026', '09', '15'])
    expect(await codexSessionDetail('feyn-0002', { root })).toBeNull()
    expect(await codexSessionDetail('nobody', { root })).toBeNull()
  })

  it('freezes the thread at `at`: later calls and later subagents have not happened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-codex-detail-'))
    writeThread(root, ['2026', '09', '15'])
    const detail = (await codexSessionDetail(LEAD, { root, at: FROM + 250 }))!
    expect(detail.parent.requests.map((r) => r.t)).toEqual([FROM + 100])
    expect(detail.subagents.map((lane) => [lane.label, lane.requests.length])).toEqual([['Feynman · explorer', 1]])
    expect(detail.cost).toBeCloseTo(13)
    expect(detail.end).toBe(FROM + 200)
    expect(await codexSessionDetail(LEAD, { root, at: FROM + 50 })).toBeNull()
  })

  it('finds a thread whose rollouts were last written long ago', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tally-codex-detail-'))
    writeThread(root, ['2025', '01', '10'], Date.UTC(2025, 0, 10, 12) / 1000)
    expect(threadSince(LEAD, root)).toBe(Date.UTC(2025, 0, 9) / 1000)
    expect(threadSince('nobody', root)).toBeNull()
    const detail = (await codexSessionDetail(LEAD, { root, now: Date.UTC(2026, 8, 17) / 1000 }))!
    expect(detail.subagents).toHaveLength(2)
  })
})

describe('splitCodexWeek', () => {
  const window = { from: FROM, resetsAt: RESET }

  it('judges liveness by the last write before the cutoff, not one after it', () => {
    const late = rollout('a', [['r1', FROM + 100, 10]])
    late.lastT = FROM + 9_000
    const split = splitCodexWeek([late], window, { t: FROM + 300, pct: 2 }, new Map(), FROM + 5_000)!
    expect(split.threads[0].live).toBe(false)
  })

  it('splits the meter by credits and puts the biggest thread first', () => {
    const split = splitCodexWeek(
      [rollout('small', [['s1', FROM + 100, 10]]), rollout('big', [['b1', FROM + 200, 30]])],
      window,
      { t: FROM + 300, pct: 8 },
      new Map([['big', { title: 'Fix Left-Aligned Layout', live: true }]]),
      FROM + 10_000,
    )!
    expect(split.threads.map((row) => [row.id, row.title, row.share, row.points])).toEqual([
      ['big', 'Fix Left-Aligned Layout', 0.75, 6],
      ['small', 'tally · small', 0.25, 2],
    ])
    expect(split.threads[0]).toMatchObject({ live: true, via: 't3', project: 'tally' })
    expect(split.creditsPerPoint).toBeCloseTo(5)
  })

  it('folds subagents into the root, counts them, and counts a copied call once', () => {
    const root = rollout('root', [['r1', FROM + 100, 10]])
    const child = rollout('child', [['c1', FROM + 150, 10]], { session_id: 'root', parent_thread_id: 'root' })
    const duplicate = rollout('root', [['r1', FROM + 100, 10]])
    const split = splitCodexWeek([root, child, duplicate], window, { t: FROM + 300, pct: 4 }, new Map(), FROM + 10_000)!
    expect(split.threads).toHaveLength(1)
    expect(split.threads[0]).toMatchObject({ id: 'root', credits: 20, calls: 2, subagents: 1, share: 1 })
  })

  it('leaves calls before the window out and calls after the reading pending', () => {
    const split = splitCodexWeek(
      [rollout('a', [['old', FROM - 60, 50], ['in', FROM + 100, 10], ['late', FROM + 400, 7]])],
      window,
      { t: FROM + 300, pct: 2 },
      new Map(),
      FROM + 10_000,
    )!
    expect(split.totalCredits).toBe(10)
    expect(split.pendingCredits).toBe(7)
  })

  it('anchors on a rollout reading fresher than the reader, ignoring last week', () => {
    const lines = [meta('a'), turn('gpt-5.6-sol'), usage('a', 'r1', FROM + 100, { input: 100_000, output: 0 }), reading(FROM + 500, 6), reading(FROM - 10, 90, FROM)]
    const split = splitCodexWeek([parseRolloutLines('/r/a.jsonl', lines)!], window, { t: FROM + 300, pct: 5 }, new Map(), FROM + 10_000)!
    expect(split).toMatchObject({ to: FROM + 500, pct: 6 })
  })

  it('has nothing to split without any reading', () => {
    expect(splitCodexWeek([rollout('a', [['r1', FROM + 100, 10]])], window, null, new Map(), FROM + 10_000)).toBeNull()
  })

  it('leaves threads routed elsewhere off the list', () => {
    const routed = rollout('routed', [['x1', FROM + 100, 99]], { model_provider: 'AgentRouter' })
    const split = splitCodexWeek([routed, rollout('a', [['a1', FROM + 100, 1]])], window, { t: FROM + 300, pct: 1 }, new Map(), FROM + 10_000)!
    expect(split.threads.map((row) => row.id)).toEqual(['a'])
  })
})

describe('pointSteps', () => {
  it('prices each point from the calls between its first sighting and the next', () => {
    const lines = [
      meta('a'),
      turn('gpt-5.6-sol'),
      usage('a', 'r1', FROM + 10, { input: 800_000, output: 0 }),
      reading(FROM + 20, 1),
      usage('a', 'r2', FROM + 30, { input: 1_000_000, output: 0 }),
      reading(FROM + 40, 2),
      // a lagging reading of an older level is ignored
      reading(FROM + 45, 1),
      usage('a', 'r3', FROM + 50, { input: 2_400_000, output: 0 }),
      reading(FROM + 60, 4),
    ]
    expect(pointSteps([parseRolloutLines('/r/a.jsonl', lines)!], { from: FROM, resetsAt: RESET }, FROM + 100)).toEqual({ min: 80, max: 120, count: 3 })
  })

  it('says nothing under three steps', () => {
    const lines = [meta('a'), turn('gpt-5.6-sol'), usage('a', 'r1', FROM + 10, { input: 100, output: 0 }), reading(FROM + 20, 1)]
    expect(pointSteps([parseRolloutLines('/r/a.jsonl', lines)!], { from: FROM, resetsAt: RESET }, FROM + 100)).toBeNull()
  })
})
