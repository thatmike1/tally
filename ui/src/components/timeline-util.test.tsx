import { describe, expect, it } from 'vitest'
import {
  activeIn,
  approxPoints,
  clampView,
  dayAfter,
  dayStart,
  detailFor,
  laneResolution,
  lanesWindow,
  MIN_SPAN,
  modelName,
  panView,
  periodOf,
  reachIn,
  snapStep,
  ticks,
  trimDay,
  zoomFor,
  zoomView,
} from './timeline-util'

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

describe('a free view', () => {
  const HOUR = 3600
  const DAY = 86400
  const history = { from: WED_MIDNIGHT - 30 * DAY, to: WED_MIDNIGHT + DAY + 3 * HOUR }
  const day = { from: WED_MIDNIGHT, to: WED_MIDNIGHT + DAY }

  it('ticks follow the span and the width, from minutes to weeks', () => {
    const hour = ticks({ from: WED_1400, to: WED_1400 + HOUR }, 1700)
    expect(hour[1]!.t - hour[0]!.t).toBe(5 * 60)
    expect(hour[0]!.label).toBe('14:00')
    const narrowDay = ticks(day, 300)
    expect(narrowDay[1]!.t - narrowDay[0]!.t).toBe(12 * HOUR)
    const wideDay = ticks(day, 1700)
    expect(wideDay[1]!.t - wideDay[0]!.t).toBe(2 * HOUR)
    const all = ticks(history, 300)
    expect(all.every((t) => t.major)).toBe(true)
    expect(all.length).toBeLessThanOrEqual(4)
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it('merges lanes at about half a pixel of time, never under five minutes', () => {
    expect(laneResolution({ from: WED_1400, to: WED_1400 + HOUR }, 1700)).toBe(300)
    expect(laneResolution(day, 1700)).toBe(300)
    expect(laneResolution({ from: WED_MIDNIGHT, to: WED_MIDNIGHT + 7 * DAY }, 700)).toBe(600)
    expect(laneResolution(history, 300)).toBe(300 * 2 ** 4)
    // a span between two rungs rounds up, so a pan or a small zoom asks for the same one
    expect(laneResolution({ from: 0, to: 602 * 1000 }, 1000)).toBe(600)
  })

  it('snaps a drag to a round step about two pixels wide', () => {
    expect(snapStep({ from: WED_1400, to: WED_1400 + HOUR }, 1700)).toBe(60)
    expect(snapStep(day, 1100)).toBe(5 * 60)
    expect(snapStep({ from: WED_MIDNIGHT, to: WED_MIDNIGHT + 7 * DAY }, 1100)).toBe(30 * 60)
    expect(snapStep(history, 300)).toBe(HOUR)
  })

  it('draws block detail by how wide a block is, so a narrow chart thins sooner', () => {
    expect(detailFor(day, 1700)).toBe('fine')
    expect(detailFor(day, 300)).toBe('fine')
    expect(detailFor({ from: WED_MIDNIGHT, to: WED_MIDNIGHT + 7 * DAY }, 1700)).toBe('mid')
    expect(detailFor({ from: WED_MIDNIGHT, to: WED_MIDNIGHT + 7 * DAY }, 300)).toBe('coarse')
    expect(detailFor(history, 1700)).toBe('coarse')
  })

  it('zooms around the point under the pointer and stops at an hour and at the history', () => {
    const at = WED_MIDNIGHT + 6 * HOUR
    const zoomed = zoomView(day, 0.5, at, history)
    expect(zoomed.to - zoomed.from).toBe(12 * HOUR)
    expect((at - zoomed.from) / (zoomed.to - zoomed.from)).toBeCloseTo(0.25)
    expect(zoomView(day, 1e-6, at, history).to - zoomView(day, 1e-6, at, history).from).toBe(MIN_SPAN)
    expect(zoomView(day, 1e6, at, history)).toEqual(history)
  })

  it('pans and stops at the ends of the history', () => {
    expect(panView(day, HOUR, history)).toEqual({ from: day.from + HOUR, to: day.to + HOUR })
    expect(panView(day, 365 * DAY, history)).toEqual({ from: history.to - DAY, to: history.to })
    expect(panView(day, -365 * DAY, history)).toEqual({ from: history.from, to: history.from + DAY })
    expect(clampView({ from: 0, to: 1e12 }, history)).toEqual(history)
  })

  it('reads lanes for a window a pan inside it does not change', () => {
    const view = { from: WED_1400, to: WED_1400 + 2 * HOUR }
    const window = lanesWindow(view, history)
    expect(window.from).toBeLessThanOrEqual(view.from)
    expect(window.to).toBeGreaterThanOrEqual(view.to)
    expect(lanesWindow(panView(view, 600, history), history)).toEqual(window)
    expect(lanesWindow({ from: history.from, to: history.from + 20 * DAY }, history)).toEqual(history)
  })
})
