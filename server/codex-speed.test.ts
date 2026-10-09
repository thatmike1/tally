// real T3 event history and rollout files, including a speed change on a resumed thread.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { codexSpeed, t3TurnSpeeds } from './codex-speed'
import { scanRollouts, splitCodexWeek } from './codex-sessions'
import { buildCodexHistory } from './history-codex'

const FROM = 2_000_000_000 - 7 * 86_400
const RESET = 2_000_000_000
const iso = (t: number) => new Date(t * 1000).toISOString()

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'tally-speed-'))
  const state = join(home, '.t3', 'userdata', 'state.sqlite')
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true })
  const db = new DatabaseSync(state)
  db.exec('CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT)')
  const insert = db.prepare('INSERT INTO orchestration_events (event_type, payload_json) VALUES (?, ?)')
  const event = (type: string, payload: unknown) => insert.run(type, JSON.stringify(payload))
  const begin = (turnId: string, options: unknown, threadId = 't3') => {
    event('thread.turn-start-requested', { threadId, modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol', options } })
    event('thread.session-set', { threadId, session: { providerName: 'codex', status: 'running', activeTurnId: turnId } })
  }
  return { home, state, db, event, begin }
}

function lines(id: string, turns: [string, number][], child = false) {
  return [
    { timestamp: iso(FROM), type: 'session_meta', payload: { id, ...(child ? { parent_thread_id: 'fast-root', session_id: 'fast-root' } : {}) } },
    { timestamp: iso(FROM + 1), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 0, window_minutes: 10_080, resets_at: RESET } } } },
    ...turns.flatMap(([turnId, t]) => [
      { timestamp: iso(t), type: 'turn_context', payload: { model: 'gpt-6.1-sol', turn_id: child ? 'child-turn' : turnId, root_turn_id: turnId } },
      { timestamp: iso(t + 1), type: 'token_usage_record', payload: { thread_id: id, turn_id: child ? 'child-turn' : turnId, root_turn_id: turnId, response_id: `${id}-${turnId}`, usage: { input_tokens: 1_000_000, cached_input_tokens: 100_000, output_tokens: 100_000 } } },
    ]),
    { timestamp: iso(FROM + 100), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 10_080, resets_at: RESET } } } },
  ].map((line) => JSON.stringify(line)).join('\n')
}

function writeRollout(home: string, id: string, turns: [string, number][], child = false) {
  const dir = join(home, '.codex', 'sessions', '2033', '05', '18')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-${id}.jsonl`), lines(id, turns, child))
}

describe('T3 speed history', () => {
  it('normalizes both fast names and leaves unsupported tiers unknown', () => {
    expect(codexSpeed('priority')).toBe('fast')
    expect(codexSpeed('fast')).toBe('fast')
    expect(codexSpeed('default')).toBe('standard')
    expect(codexSpeed('ultrafast')).toBeNull()
    expect(codexSpeed(undefined)).toBeNull()
  })

  it('uses per-turn history, legacy fastMode, inherited selection and late-arriving events', () => {
    const f = fixture()
    try {
      f.begin('fast', [{ id: 'serviceTier', value: 'priority' }])
      f.begin('standard', { fastMode: false })
      f.event('thread.turn-start-requested', { threadId: 't3' })
      f.event('thread.session-set', { threadId: 't3', session: { providerName: 'codex', activeTurnId: 'inherited' } })
      f.begin('unknown', [])
      expect([...t3TurnSpeeds(f.state)]).toEqual([['fast', 'fast'], ['standard', 'standard'], ['inherited', 'standard'], ['unknown', null]])
      f.begin('late', { fastMode: true })
      expect(t3TurnSpeeds(f.state).get('late')).toBe('fast')
      // a new queued request must not overwrite a previous turn's historical speed
      f.begin('fast', { fastMode: false })
      expect(t3TurnSpeeds(f.state).get('fast')).toBe('fast')
      expect(t3TurnSpeeds('/does-not-exist/t3.sqlite').size).toBe(0)
    } finally {
      f.db.close()
    }
  })

  it('recovers speeds for a lead and its child, prices mixed-speed history and weights the allowance split', async () => {
    const f = fixture()
    try {
      f.begin('f', [{ id: 'serviceTier', value: 'fast' }])
      f.begin('s', [{ id: 'serviceTier', value: 'default' }], 'other-t3')
      writeRollout(f.home, 'fast-root', [['f', FROM + 10]])
      writeRollout(f.home, 'standard-root', [['s', FROM + 20]])
      writeRollout(f.home, 'child', [['f', FROM + 30]], true)
      const root = join(f.home, '.codex', 'sessions')
      const rollouts = await scanRollouts(0, root)
      expect(rollouts.flatMap((r) => r.calls).filter((c) => c.speed === 'fast')).toHaveLength(2)
      const split = splitCodexWeek(rollouts, { from: FROM, resetsAt: RESET }, null, new Map(), FROM + 100)!
      // each standard call is 70.25 purchased credits; the fast root has two 2x calls
      expect(split.totalCredits).toBeCloseTo(70.25 * 5)
      expect(split.threads.find((r) => r.id === 'fast-root')?.share).toBeCloseTo(5 / 6)
      expect(split.unknownSpeedCalls).toBe(0)
      const history = await buildCodexHistory({ home: f.home, now: FROM + 100 })
      expect(history.windows[0]?.costUsd).toBeCloseTo(2.81 * 5)
      expect(history.windows[0]?.byModel['gpt-6.1-sol']?.unknownSpeedCalls).toBe(0)
    } finally {
      f.db.close()
    }
  })

  it('fills a cached rollout when its T3 turn mapping arrives later', async () => {
    const f = fixture()
    try {
      writeRollout(f.home, 'fast-root', [['late', FROM + 10]])
      const root = join(f.home, '.codex', 'sessions')
      expect((await scanRollouts(0, root))[0]?.calls[0]?.speed).toBeNull()
      f.begin('late', [{ id: 'serviceTier', value: 'priority' }])
      expect((await scanRollouts(0, root))[0]?.calls[0]?.speed).toBe('fast')
    } finally {
      f.db.close()
    }
  })
})
