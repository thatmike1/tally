// every source that read the Codex meter feeds one set of readings: the page's
// running week and the history route's windows are cut from it, and an hour no
// source read stays a gap
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexMeterLogs, meterReadings, observedReadings, runningWindow } from './codex-observed'
import { codexSessionRoots, scanRollouts, type CodexRollout } from './codex-sessions'
import { thinHistory } from './codex-usage'
import { buildCodexHistory } from './history-codex'

const WEEK = 7 * 86_400
const RESET = 2_000_000_000
const FROM = RESET - WEEK
const iso = (t: number) => new Date(t * 1000).toISOString()

const meta = (id: string) =>
  JSON.stringify({ timestamp: iso(FROM), type: 'session_meta', payload: { id, session_id: id, cwd: '/w', originator: 'codex_exec', model_provider: 'openai' } })
const turn = JSON.stringify({ timestamp: iso(FROM), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })
const usage = (thread: string, response: string, t: number) =>
  JSON.stringify({ timestamp: iso(t), type: 'token_usage_record', payload: { thread_id: thread, response_id: response, usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } })
const reading = (t: number, pct: number) =>
  JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10_080, resets_at: RESET } } } })
const meterLine = (t: number, pct: number) => JSON.stringify({ sampledAt: t, usedPercent: pct, resetsAt: RESET, windowDurationMins: 10_080 })

function write(path: string, lines: string[]) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

/**
 * a desktop that read the meter in the evening and the morning, a laptop whose
 * overnight run is copied into `codex-sources/laptop`, and a VPS meter log
 * copied into `codex-sources/vps` that covers the hours the laptop did not
 */
function overnightHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tally-codex-observed-'))
  const day = (root: string) => join(root, '2033', '05', '17')
  write(join(home, '.cache', 'tally', 'codex-usage.jsonl'), [meterLine(FROM + 3600, 10), meterLine(FROM + 7200, 11), meterLine(FROM + 40_000, 30)])
  const laptopSessions = join(home, '.cache', 'tally', 'codex-sources', 'laptop', 'sessions')
  write(join(day(laptopSessions), 'rollout-2033-05-17T01-00-00-night.jsonl'), [
    meta('night'), turn,
    usage('night', 'r1', FROM + 10_000), reading(FROM + 10_001, 14),
    usage('night', 'r2', FROM + 11_000), reading(FROM + 11_001, 17),
  ])
  // the same run copied a second time by an older single-source mirror counts once
  write(join(day(join(home, '.cache', 'tally', 'codex-upstream')), 'rollout-2033-05-17T01-00-00-night.jsonl'), [
    meta('night'), turn, usage('night', 'r1', FROM + 10_000), reading(FROM + 10_001, 14),
  ])
  write(join(home, '.cache', 'tally', 'codex-sources', 'vps', 'codex-usage.jsonl'), [meterLine(FROM + 20_000, 21), meterLine(FROM + 20_300, 21)])
  // a source that was offline at every copy: a directory and nothing in it
  mkdirSync(join(home, '.cache', 'tally', 'codex-sources', 'asleep', 'sessions'), { recursive: true })
  return home
}

describe('observed Codex readings', () => {
  it('reads every machine source beside this one and counts a copied call once', async () => {
    const home = overnightHome()
    const roots = codexSessionRoots(home)
    expect(roots.map((root) => root.slice(home.length))).toEqual([
      '/.codex/sessions',
      '/.cache/tally/codex-upstream',
      '/.cache/tally/codex-sources/asleep/sessions',
      '/.cache/tally/codex-sources/laptop/sessions',
      '/.cache/tally/codex-sources/vps/sessions',
    ])
    const rollouts = await scanRollouts(0, roots)
    // the same file name under two roots is one thread, read from its longer copy
    expect(rollouts.map((r) => [r.id, r.calls.length, r.path.includes('/laptop/')])).toEqual([['night', 2, true]])
    expect(codexMeterLogs(home).map((path) => path.slice(home.length))).toEqual([
      '/.cache/tally/codex-usage.jsonl',
      '/.cache/tally/codex-sources/asleep/codex-usage.jsonl',
      '/.cache/tally/codex-sources/laptop/codex-usage.jsonl',
      '/.cache/tally/codex-sources/vps/codex-usage.jsonl',
    ])
  })

  it('merges meter logs and rollout readings in time order, each reading once', () => {
    const rollout = { openai: true, readings: [{ t: 5, pct: 2, resetsAt: RESET }, { t: 1, pct: 1, resetsAt: RESET }] } as CodexRollout
    const routed = { openai: false, readings: [{ t: 3, pct: 50, resetsAt: RESET }] } as CodexRollout
    expect(observedReadings([{ t: 5, pct: 2, resetsAt: RESET }, { t: 9, pct: 3, resetsAt: RESET }], [rollout, routed])).toEqual([
      { t: 1, pct: 1, resetsAt: RESET },
      { t: 5, pct: 2, resetsAt: RESET },
      { t: 9, pct: 3, resetsAt: RESET },
    ])
  })

  it('cuts the running week from every source, keeping times and the unread hours as gaps', async () => {
    const home = overnightHome()
    const rollouts = await scanRollouts(0, codexSessionRoots(home))
    const now = FROM + 50_000
    const running = runningWindow(observedReadings(meterReadings(codexMeterLogs(home)), rollouts), now)!
    expect(running.map((r) => [r.sampledAt - FROM, r.usedPercent])).toEqual([
      [3600, 10], [7200, 11], [10_001, 14], [11_001, 17], [20_000, 21], [20_300, 21], [40_000, 30],
    ])
    // 11 → 14 and 21 → 30 are separated by more than the reader's gap, so the line breaks there
    expect(thinHistory(running).map((p) => [p.t - FROM, p.pct, p.afterGap])).toEqual([
      [3600, 10, false], [7200, 11, true], [10_001, 14, true], [11_001, 17, false], [20_300, 21, true], [40_000, 30, true],
    ])
    // the route's running window is the same set of readings
    const history = await buildCodexHistory({ home, now, installed: true })
    const partial = history.windows.at(-1)!
    expect(partial.partial).toBe(true)
    expect(partial.points).toEqual(thinHistory(running))
    expect(history.sources.machines).toEqual(['asleep', 'laptop', 'vps'])
  })

  it('has no running week once the last observed reset has passed', () => {
    expect(runningWindow([{ t: FROM + 10, pct: 4, resetsAt: RESET }], RESET + 1)).toBeNull()
  })
})
