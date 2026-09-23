import { describe, expect, it } from 'vitest'
import { activeIn, approxPoints, dayAfter, dayStart, modelName, periodOf, reachIn, ticks, trimDay, zoomFor } from './timeline-util'

// 2026-09-23 14:00 in Prague (CEST, UTC+2)
const WED_1400 = Date.UTC(2026, 8, 23, 12, 0) / 1000
const WED_MIDNIGHT = Date.UTC(2026, 8, 22, 22, 0) / 1000

describe('prague days', () => {
  it('finds local midnight in summer time', () => {
    expect(dayStart(WED_1400)).toBe(WED_MIDNIGHT)
    expect(dayStart(WED_MIDNIGHT)).toBe(WED_MIDNIGHT)
    expect(dayStart(WED_MIDNIGHT - 1)).toBe(WED_MIDNIGHT - 86400)
  })

  it('makes the day DST ends 25 hours long', () => {
    // 25 Oct 2026, clocks go back at 03:00
    const sunday = Date.UTC(2026, 9, 25, 10, 0) / 1000
    const start = dayStart(sunday)
    expect(start).toBe(Date.UTC(2026, 9, 24, 22, 0) / 1000)
    expect(dayAfter(sunday) - start).toBe(25 * 3600)
  })
})

describe('zoom periods', () => {
  const weeks = [{ start: Date.UTC(2026, 8, 19, 21, 0) / 1000, resetsAt: Date.UTC(2026, 8, 26, 21, 0) / 1000 }]

  it('reads a day as the calendar day and a week as the weekly window', () => {
    expect(periodOf('day', WED_1400, weeks, 0, WED_1400)).toEqual({ from: WED_MIDNIGHT, to: WED_MIDNIGHT + 86400 })
    expect(periodOf('week', WED_1400, weeks, 0, WED_1400)).toEqual({ from: weeks[0]!.start, to: weeks[0]!.resetsAt })
  })

  it('picks the smallest zoom a range fits in', () => {
    expect(zoomFor({ from: WED_1400, to: WED_1400 + 3600 })).toBe('day')
    expect(zoomFor({ from: WED_1400 - 20 * 3600, to: WED_1400 })).toBe('week')
    expect(zoomFor({ from: WED_1400 - 9 * 86400, to: WED_1400 })).toBe('since')
  })

  it('trims a day to where something happened, never past the day', () => {
    const day = { from: WED_MIDNIGHT, to: WED_MIDNIGHT + 86400 }
    const trimmed = trimDay(day, [WED_MIDNIGHT + 8.5 * 3600, WED_MIDNIGHT + 14.2 * 3600])
    expect(trimmed).toEqual({ from: WED_MIDNIGHT + 7.5 * 3600, to: WED_MIDNIGHT + 15.5 * 3600 })
    expect(trimDay(day, [])).toEqual(day)
  })
})

describe('axis and lanes', () => {
  it('puts ticks on local clock marks and labels midnight with the day', () => {
    const got = ticks({ from: WED_MIDNIGHT - 3600, to: WED_MIDNIGHT + 3 * 3600 }, 400)
    expect(got.map((t) => t.label)).toEqual(['23:00', 'Wed 23', '01:00', '02:00', '03:00'])
    expect(got[1]!.major).toBe(true)
  })

  it('counts only the activity inside a range', () => {
    const segments = [
      { from: 0, to: 100 },
      { from: 200, to: 300 },
    ]
    expect(activeIn(segments, { from: 50, to: 250 })).toBe(100)
    expect(reachIn(segments, { from: 50, to: 250 })).toEqual({ from: 50, to: 250 })
    expect(reachIn(segments, { from: 120, to: 180 })).toBeNull()
  })

  it('names models the way a person says them', () => {
    expect(modelName('claude-opus-5-5')).toBe('opus 5.5')
    expect(modelName('claude-sonnet-5')).toBe('sonnet 5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(modelName('gpt-6-sol')).toBe('gpt 6 sol')
  })

  it('never shows an approximate point figure as exact', () => {
    expect(approxPoints(null)).toBe('not measured')
    expect(approxPoints(0.2)).toBe('<1')
    expect(approxPoints(11.6)).toBe('~12')
  })
})
