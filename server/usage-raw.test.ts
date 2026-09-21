// the `seven_day_breakdown` reader, over a hand-written raw usage log.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { breakdownForWindow, chatsPercent, readBreakdowns, usageRawPath } from './usage-raw'

const iso = (t: number) => new Date(t * 1000).toISOString()

function rawRow(t: number, windowStart: number, chat: number): string {
  return JSON.stringify({
    t,
    payload: {
      seven_day: { utilization: 20 },
      seven_day_breakdown: {
        as_of: iso(t - 60),
        window_started_at: windowStart === 0 ? null : iso(windowStart),
        rows: [
          { key: 'claude_code', display_name: 'Claude Code', percent: 100 - chat },
          { key: 'chat', display_name: 'Chats', percent: chat },
          { key: 'cowork', display_name: 'Cowork', percent: 0 },
        ],
      },
    },
  })
}

const WINDOW = 1_789_246_800
const PREVIOUS = WINDOW - 7 * 24 * 3600

function logWith(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tally-usage-raw-')), 'usage-raw.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

describe('usageRawPath', () => {
  it('falls back to the cc-browse-tray copy, and takes the new one as soon as it exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-home-'))
    mkdirSync(join(home, '.cache', 'cc-browse-tray'), { recursive: true })
    writeFileSync(join(home, '.cache', 'cc-browse-tray', 'usage-raw.jsonl'), '')
    expect(usageRawPath(home)).toBe(join(home, '.cache', 'cc-browse-tray', 'usage-raw.jsonl'))

    mkdirSync(join(home, '.cache', 'tally'), { recursive: true })
    writeFileSync(join(home, '.cache', 'tally', 'usage-raw.jsonl'), '')
    expect(usageRawPath(home)).toBe(join(home, '.cache', 'tally', 'usage-raw.jsonl'))
  })
})

describe('readBreakdowns', () => {
  it('skips malformed lines and rows with no breakdown', () => {
    const path = logWith([
      '{ this is not json',
      JSON.stringify({ t: 100, payload: { seven_day: { utilization: 3 } } }),
      JSON.stringify({ t: 101, payload: { seven_day_breakdown: { rows: 'nope' } } }),
      JSON.stringify({ payload: { seven_day_breakdown: { rows: [{ key: 'chat', percent: 10 }] } } }),
      rawRow(200, PREVIOUS, 40),
      '',
      '{"t":300,"payload":{"seven_day_break',
    ])
    const rows = readBreakdowns(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.at).toBe(200)
    expect(rows[0]!.rows).toEqual({ claude_code: 60, chat: 40, cowork: 0 })
    expect(rows[0]!.windowStart).toBe(PREVIOUS)
    expect(rows[0]!.asOf).toBe(140)
  })

  it('has nothing to say about a missing log', () => {
    expect(readBreakdowns(join(tmpdir(), 'tally-no-such-usage-raw.jsonl'))).toEqual([])
  })
})

describe('breakdownForWindow', () => {
  const rows = readBreakdowns(
    logWith([
      rawRow(PREVIOUS + 3600, PREVIOUS, 10),
      rawRow(PREVIOUS + 7200, PREVIOUS, 25),
      // sampled a minute after this window reset: it already describes the next one
      rawRow(WINDOW + 60, WINDOW, 5),
      rawRow(WINDOW + 3600, WINDOW, 8),
    ]),
  )

  it('takes the last row sampled before the reset', () => {
    const found = breakdownForWindow(rows, { windowStart: PREVIOUS, resetsAt: WINDOW, partial: false })
    expect(found?.at).toBe(PREVIOUS + 7200)
    expect(chatsPercent(found)).toBe(25)
  })

  it('takes the latest row while the window is still open', () => {
    const found = breakdownForWindow(rows, { windowStart: WINDOW, resetsAt: WINDOW + 7 * 24 * 3600, partial: true })
    expect(found?.at).toBe(WINDOW + 3600)
    expect(chatsPercent(found)).toBe(8)
  })

  it('never borrows a neighbouring window’s breakdown', () => {
    const older = { windowStart: PREVIOUS - 7 * 24 * 3600, resetsAt: PREVIOUS, partial: false }
    expect(breakdownForWindow(rows, older)).toBeNull()
    expect(chatsPercent(null)).toBeNull()
  })

  it('tolerates the second of jitter on window_started_at', () => {
    const found = breakdownForWindow(rows, { windowStart: PREVIOUS - 1, resetsAt: WINDOW - 1, partial: false })
    expect(found?.at).toBe(PREVIOUS + 7200)
  })
})
