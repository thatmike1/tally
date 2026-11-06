// the Codex readout under the chart's crosshair: the last reading before the
// pointer, dropped to zero once a reset has come between
import { describe, expect, it } from 'vitest'
import type { CodexWindow } from '../api'
import { codexAt, codexSeries } from './timeline-chart'
import { codexMovement } from './timeline-summary'

const window = (points: [number, number][], end: number, extra: Partial<CodexWindow> = {}) =>
  ({ partial: false, resetEarly: true, end, points: points.map(([t, pct]) => ({ t, pct, afterGap: false })), ...extra }) as CodexWindow

describe('codexAt', () => {
  const series = codexSeries(
    [window([[100, 0], [200, 40]], 300), window([[300, 0], [400, 5]], 1000, { partial: true })],
    [{ t: 500, pct: 7, afterGap: false }],
  )

  it('holds the last reading until the next one', () => {
    expect(codexAt(series, 250)).toBe(40)
  })

  it('reads 0 between an early reset and the first reading after it', () => {
    expect(series.resets).toEqual([{ t: 300, early: true }])
    expect(codexAt(series, 300)).toBe(0)
  })

  it('takes the running week from the live reader, not its partial window', () => {
    expect(codexAt(series, 450)).toBe(0)
    expect(codexAt(series, 600)).toBe(7)
  })

  it('has nothing before the first reading', () => {
    expect(codexAt(series, 50)).toBeNull()
  })
})

describe('codexMovement', () => {
  const series = codexSeries(
    [window([[100, 30], [200, 40]], 300)],
    [{ t: 400, pct: 2, afterGap: false }, { t: 500, pct: 7, afterGap: true }],
  )

  it('adds each week up on its own readings, so a reset in the range is not a drop', () => {
    expect(codexMovement(series, { from: 150, to: 600 })).toEqual({ start: 40, end: 7, delta: 5, weeks: 2 })
  })

  it('measures nothing when no week inside the range was read twice', () => {
    expect(codexMovement(series, { from: 150, to: 450 })).toEqual({ start: 40, end: 2, delta: null, weeks: 2 })
    expect(codexMovement(series, { from: 600, to: 700 })).toBeNull()
  })
})
