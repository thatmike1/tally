import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_GAP_SECONDS,
  CODEX_STALE_SECONDS,
  codexBinaryPath,
  codexPace,
  codexWorkdayDeltas,
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
import { startOfDay, weekdayName } from './time'

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

  it('says why a view frozen before the first reading has nothing', () => {
    const files = paths()
    recordCodexReading(files, { sampledAt: 1_789_450_000, usedPercent: 42, resetsAt: 1_789_950_000, windowDurationMins: 10_080 })
    expect(codexUsageView(files, 1_789_400_000, { at: 1_789_400_000 })).toMatchObject({
      status: 'unavailable',
      line: 'Codex · no reading yet, the reader started 2026-09-15',
    })
  })
})

const WEEK = 7 * 86_400
const RESET = 2_000_000_000

/** a reading `hours` into the week that resets at `RESET` */
function at(hours: number, usedPercent: number, resetsAt = RESET): CodexUsageReading {
  return { sampledAt: resetsAt - WEEK + hours * 3600, usedPercent, resetsAt, windowDurationMins: 10_080 }
}

// Monday 14 September 2026, Prague; the week opens at 10:00 and resets the next Monday at 10:00
const MON = startOfDay('2026-09-14')
const OPEN = MON + 10 * 3600
const WEEK_RESET = OPEN + WEEK

/** a reading `hours` after Monday midnight in that week */
function on(hours: number, usedPercent: number): CodexUsageReading {
  return { sampledAt: MON + hours * 3600, usedPercent, resetsAt: WEEK_RESET, windowDurationMins: 10_080 }
}

describe('codexPace', () => {
  it('paces provisionally from today when no full workday is read yet', () => {
    // 10 today, then Tue-Fri at 10 each, a free weekend, and 10/24 of Monday before the reset
    const pace = codexPace([on(11, 2), on(18, 10)])
    expect(pace).toMatchObject({ ready: true, provisional: true, typicalDay: 10, measuredDays: 0, hitsHundredAt: null })
    expect(pace!.pctAtReset).toBeCloseTo(10 + 10 * (4 + 10 / 24))
    expect(pace!.phrase).toBe('≈ 54% at reset, provisional')
  })

  it('keeps the weekend flat on the expected path', () => {
    const path = codexPace([on(18, 10)])!.path
    const saturday = startOfDay('2026-09-19')
    const monday = startOfDay('2026-09-21')
    expect(path.find((point) => point.t === monday)?.pct).toBe(path.find((point) => point.t === saturday)?.pct)
    expect(path.at(-1)).toEqual({ t: WEEK_RESET, pct: expect.closeTo(54.17, 1) })
  })

  it('switches to the median of fully read workdays and adds the rest of today', () => {
    // Tuesday burned 12, Wednesday has used 4 so far, so 8 more today, then Thu and Fri, then 10/24 of Monday
    const window = [on(12, 3), on(23.8, 10), on(47.9, 22), on(48.1, 22), on(60, 26)]
    expect(codexWorkdayDeltas(window)).toEqual([12])
    const pace = codexPace(window)
    expect(pace).toMatchObject({ ready: true, provisional: false, typicalDay: 12, measuredDays: 1 })
    expect(pace!.pctAtReset).toBeCloseTo(26 + 8 + 24 + 12 * (10 / 24))
    expect(pace!.phrase).toBe('≈ 63% at reset')
  })

  it('does not count a day the reader missed an edge of', () => {
    // nothing near Tuesday's midnights, so Tuesday is not a measured day
    const window = [on(12, 3), on(18, 10), on(60, 30), on(62, 31)]
    expect(codexWorkdayDeltas(window)).toEqual([])
    expect(codexPace(window)).toMatchObject({ ready: false, reason: 'the reader missed the start of today' })
  })

  it('names the day a fast week reaches 100', () => {
    // 30 a day from Monday evening: 60 Tuesday, 90 Wednesday, over on Thursday
    const pace = codexPace([on(18, 30)])
    expect(pace).toMatchObject({ ready: true, pctAtReset: 100, phrase: '100% by Thu, provisional' })
    expect(weekdayName(pace!.hitsHundredAt!)).toBe('Thu')
  })

  it('says today when the rest of a typical day crosses 100', () => {
    const window = [on(12, 3), on(23.8, 40), on(48.1, 90), on(60, 92)]
    expect(codexPace(window)?.phrase).toBe('100% today')
  })

  it('waits on a weekend with no workday read yet', () => {
    const saturdayOpen = startOfDay('2026-09-19') + 9 * 3600
    const reading = { sampledAt: saturdayOpen + 3 * 3600, usedPercent: 5, resetsAt: saturdayOpen + WEEK, windowDurationMins: 10_080 }
    expect(codexPace([reading])).toMatchObject({ ready: false, reason: 'no workday read yet this week', phrase: 'no pace yet' })
  })

  it('waits when nothing has been used today', () => {
    expect(codexPace([on(10.5, 0)])).toMatchObject({ ready: false, reason: 'nothing used yet today' })
  })

  it('refuses to pace a meter that went down inside the week', () => {
    expect(codexPace([on(30, 40), on(40, 5)])).toMatchObject({ ready: false, reason: 'the meter went down inside this week' })
  })

  it('says the week is spent once the meter reads 100', () => {
    expect(codexPace([on(30, 100)])).toMatchObject({ ready: true, pctAtReset: 100, phrase: 'at 100%' })
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
    for (const reading of [on(11, 2), on(18, 10)]) recordCodexReading(files, reading)
    const view = codexUsageView(files, on(18, 10).sampledAt + 60)
    expect(view.line).toBe('Codex · 10% used · resets in 6d 15h · ≈ 54% at reset, provisional')
    expect(view.windowStart).toBe(OPEN)
    expect(view.history.map((point) => point.pct)).toEqual([2, 10])
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
