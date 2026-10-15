// the Codex readout under the chart's crosshair: the last reading before the
// pointer, dropped to zero once a reset has come between
import { describe, expect, it } from 'vitest'
import type { CodexWindow } from '../api'
import { codexAt, codexSeries } from './timeline-chart'

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
