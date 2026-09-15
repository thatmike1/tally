import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_GAP_SECONDS,
  CODEX_STALE_SECONDS,
  codexBinaryPath,
  codexPace,
  currentWindowReadings,
  thinHistory,
  codexUsageView,
  readCodexHistory,
  recordCodexFailure,
  recordCodexReading,
  selectCodexWeeklyWindow,
  type CodexUsagePaths,
  type CodexUsageReading,
} from './codex-usage'
import { formatHm, weekdayName } from './time'

function paths(): CodexUsagePaths {
  const dir = mkdtempSync(join(tmpdir(), 'tally-codex-'))
  return { history: join(dir, 'history.jsonl'), status: join(dir, 'status.json') }
}

describe('selectCodexWeeklyWindow', () => {
  it('selects a seven-day window from the main bucket regardless of position', () => {
    const reading = selectCodexWeeklyWindow(
      {
        rateLimits: { limitId: 'other', secondary: { usedPercent: 90, resetsAt: 200, windowDurationMins: 10_080 } },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 2, resetsAt: 150, windowDurationMins: 300 },
            secondary: { usedPercent: 41.6, resetsAt: 900, windowDurationMins: 10_080 },
          },
        },
      },
      100,
    )
    expect(reading).toEqual({ sampledAt: 100, usedPercent: 41.6, resetsAt: 900, windowDurationMins: 10_080 })
  })

  it('does not infer weekly from primary or secondary position', () => {
    expect(selectCodexWeeklyWindow({ rateLimits: { secondary: { usedPercent: 2, resetsAt: 900 } } }, 100)).toBeNull()
  })
})

describe('codexBinaryPath', () => {
  it('finds a user-level Bun install when the service PATH does not include it', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-home-'))
    const binary = join(home, '.bun', 'bin', 'codex')
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true })
    writeFileSync(binary, '')
    expect(codexBinaryPath(home, { PATH: '/usr/bin' })).toBe(binary)
  })
})

describe('Codex usage history and view', () => {
  it('records timestamped readings and formats the glance line', () => {
    const files = paths()
    recordCodexReading(files, { sampledAt: 100, usedPercent: 1.2, resetsAt: 100 + 6 * 86_400 + 22 * 3600, windowDurationMins: 10_080 })
    expect(readCodexHistory(files.history)).toHaveLength(1)
    expect(codexUsageView(files, 100)).toMatchObject({
      status: 'fresh',
      line: 'Codex · 1% used · resets in 6d 22h · no pace yet',
      usedPercent: 1.2,
    })
  })

  it('does not present a failed read as zero or as fresh old data', () => {
    const files = paths()
    recordCodexReading(files, { sampledAt: 100, usedPercent: 42, resetsAt: 10_000, windowDurationMins: 10_080 })
    recordCodexFailure(files, 110, 'offline')
    expect(codexUsageView(files, 120)).toMatchObject({ status: 'stale', usedPercent: null })
    expect(codexUsageView(files, 120).line).not.toContain('0%')
  })

  it('marks old readings stale and hides a percentage after reset', () => {
    const staleFiles = paths()
    recordCodexReading(staleFiles, { sampledAt: 100, usedPercent: 42, resetsAt: 10_000, windowDurationMins: 10_080 })
    expect(codexUsageView(staleFiles, 100 + CODEX_STALE_SECONDS + 1)).toMatchObject({ status: 'stale', usedPercent: null })

    const resetFiles = paths()
    recordCodexReading(resetFiles, { sampledAt: 100, usedPercent: 99, resetsAt: 200, windowDurationMins: 10_080 })
    expect(codexUsageView(resetFiles, 201)).toMatchObject({
      status: 'unavailable',
      line: 'Codex · awaiting new weekly reading',
      usedPercent: null,
    })
  })
})

const WEEK = 7 * 86_400
const RESET = 2_000_000_000

/** a reading `hours` into the week that resets at `RESET` */
function at(hours: number, usedPercent: number, resetsAt = RESET): CodexUsageReading {
  return { sampledAt: resetsAt - WEEK + hours * 3600, usedPercent, resetsAt, windowDurationMins: 10_080 }
}

describe('codexPace', () => {
  it('holds back a projection for the first day of the week', () => {
    expect(codexPace([at(2, 3), at(23, 30)])).toMatchObject({
      ready: false,
      reason: 'under a day into the week',
      phrase: 'no pace yet',
      pctAtReset: null,
    })
  })

  it('projects the week from the average burn so far', () => {
    // 20 points in two days is 70 over seven
    const pace = codexPace([at(1, 2), at(48, 20)])
    expect(pace).toMatchObject({ ready: true, reason: null, hitsHundredAt: null, phrase: '≈ 70% at reset' })
    expect(pace!.pctAtReset).toBeCloseTo(70)
    expect(pace!.evenPct).toBeCloseTo((48 / 168) * 100)
  })

  it('names when a fast week reaches 100', () => {
    // 50 points in two days reaches 100 at hour 96
    const pace = codexPace([at(48, 50)])
    const hits = RESET - WEEK + 96 * 3600
    expect(pace).toMatchObject({ ready: true, pctAtReset: 100, hitsHundredAt: hits })
    expect(pace!.phrase).toBe(`100% by ${weekdayName(hits)} ${formatHm(hits)}`)
  })

  it('projects from one sparse reading, since the meter is cumulative', () => {
    expect(codexPace([at(84, 10)])?.phrase).toBe('≈ 20% at reset')
  })

  it('gives the same projection whether or not the reader missed a stretch', () => {
    const dense = Array.from({ length: 49 }, (_, hour) => at(hour, hour / 2))
    const gappy = [at(0, 0), at(1, 0.5), at(48, 24)]
    expect(codexPace(gappy)?.pctAtReset).toBeCloseTo(codexPace(dense)!.pctAtReset!)
  })

  it('refuses to average across a meter that went down inside the week', () => {
    expect(codexPace([at(30, 40), at(40, 5)])).toMatchObject({ ready: false, reason: 'the meter went down inside this week' })
  })

  it('says the week is spent once the meter reads 100', () => {
    expect(codexPace([at(10, 100)])).toMatchObject({ ready: true, pctAtReset: 100, phrase: 'at 100%' })
  })

  it('has nothing to say without readings', () => {
    expect(codexPace([])).toBeNull()
  })
})

describe('currentWindowReadings', () => {
  it('drops the previous week and tolerates a jittering reset', () => {
    const previous = at(160, 90, RESET - WEEK)
    const current = [at(2, 1), { ...at(3, 2), resetsAt: RESET + 1 }, at(4, 3)]
    expect(currentWindowReadings([previous, ...current])).toEqual(current)
  })
})

describe('thinHistory', () => {
  it('keeps the last reading per step and marks gaps', () => {
    const base = 1_800_000_000 - (1_800_000_000 % 900)
    const reading = (offset: number, usedPercent: number) => ({ sampledAt: base + offset, usedPercent, resetsAt: RESET, windowDurationMins: 10_080 })
    const points = thinHistory([reading(0, 1), reading(300, 2), reading(600, 3), reading(900, 4), reading(900 + CODEX_GAP_SECONDS + 1, 9)])
    expect(points).toEqual([
      { t: base + 600, pct: 3, afterGap: false },
      { t: base + 900, pct: 4, afterGap: false },
      { t: base + 900 + CODEX_GAP_SECONDS + 1, pct: 9, afterGap: true },
    ])
  })
})

describe('codexUsageView pace', () => {
  it('carries the verdict into the glance line and the window history to the page', () => {
    const files = paths()
    for (const reading of [at(1, 2), at(48, 20)]) recordCodexReading(files, reading)
    const view = codexUsageView(files, at(48, 20).sampledAt + 60)
    expect(view.line).toBe('Codex · 20% used · resets in 4d 23h · ≈ 70% at reset')
    expect(view.windowStart).toBe(RESET - WEEK)
    expect(view.history.map((point) => point.pct)).toEqual([2, 20])
    expect(view.history[1]?.afterGap).toBe(true)
  })

  it('keeps the history but drops the verdict when the reading is stale', () => {
    const files = paths()
    recordCodexReading(files, at(48, 20))
    const view = codexUsageView(files, at(48, 20).sampledAt + CODEX_STALE_SECONDS + 1)
    expect(view).toMatchObject({ status: 'stale', pace: null, usedPercent: null })
    expect(view.line).not.toContain('at reset')
    expect(view.history).toHaveLength(1)
  })

  it('drops the verdict and the history once the reset has passed', () => {
    const files = paths()
    recordCodexReading(files, at(160, 95))
    expect(codexUsageView(files, RESET + 1)).toMatchObject({ status: 'unavailable', pace: null, history: [], windowStart: null })
  })
})
