// the Prague clock, including the two DST days it has to survive.
import { describe, expect, it } from 'vitest'
import { dayBounds, dayKey, isWeekend, startOfDay, weekdayName, workdaysBetween } from './time'

const at = (iso: string) => Date.parse(iso) / 1000

describe('dayKey', () => {
  it('uses the Prague calendar day, not UTC', () => {
    // 23:30 UTC is already the next day in Prague
    expect(dayKey(at('2026-09-10T23:30:00Z'))).toBe('2026-09-11')
    expect(dayKey(at('2026-09-10T21:59:00Z'))).toBe('2026-09-10')
  })
})

describe('startOfDay', () => {
  it('lands on local midnight in summer time', () => {
    expect(startOfDay('2026-09-11')).toBe(at('2026-09-11T00:00:00+02:00'))
  })

  it('lands on local midnight in winter time', () => {
    expect(startOfDay('2026-01-15')).toBe(at('2026-01-15T00:00:00+01:00'))
  })

  it('survives both DST switch days', () => {
    // clocks go forward on 29 March 2026 and back on 25 October 2026
    expect(startOfDay('2026-03-29')).toBe(at('2026-03-29T00:00:00+01:00'))
    expect(startOfDay('2026-10-25')).toBe(at('2026-10-25T00:00:00+02:00'))
  })
})

describe('dayBounds', () => {
  it('is 24 hours on an ordinary day', () => {
    const [start, end] = dayBounds(at('2026-09-11T14:00:00+02:00'))
    expect(end - start).toBe(24 * 3600)
  })

  it('is 23 hours on the short day and 25 on the long one', () => {
    expect(dayBounds(at('2026-03-29T12:00:00+02:00')).reduce((a, b) => b - a)).toBe(23 * 3600)
    expect(dayBounds(at('2026-10-25T12:00:00+01:00')).reduce((a, b) => b - a)).toBe(25 * 3600)
  })
})

describe('weekdays', () => {
  it('knows the weekend in Prague', () => {
    expect(weekdayName(at('2026-09-11T12:00:00+02:00'))).toBe('Fri')
    expect(isWeekend(at('2026-09-12T12:00:00+02:00'))).toBe(true)
    expect(isWeekend(at('2026-09-14T12:00:00+02:00'))).toBe(false)
  })

  it('counts the workdays left, weekend days excluded', () => {
    // Friday noon to Saturday 23:00: Friday only
    expect(workdaysBetween(at('2026-09-11T12:00:00+02:00'), at('2026-09-12T23:00:00+02:00'))).toBe(1)
    // Friday noon to next Wednesday: Fri, Mon, Tue, Wed
    expect(workdaysBetween(at('2026-09-11T12:00:00+02:00'), at('2026-09-16T23:00:00+02:00'))).toBe(4)
    expect(workdaysBetween(at('2026-09-11T12:00:00+02:00'), at('2026-09-11T11:00:00+02:00'))).toBe(0)
  })
})
