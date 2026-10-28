import { expect, it } from 'vitest'
import { ago, dayClock, dayDate, dayKey, days, duration, hm, labelOn, money, pct, projectName, rate, ratio, tokens, until } from './format'

it('formatting uses Prague dates across midnight and the daylight saving change', () => {
  const summer = Date.parse('2026-07-01T22:15:00Z') / 1000
  const winter = Date.parse('2026-10-25T01:30:00Z') / 1000
  expect(hm(summer)).toBe('00:15')
  expect(dayClock(summer)).toBe('Thu 00:15')
  expect(dayDate(summer)).toBe('Thu 2 Jul')
  expect(dayKey(summer)).toBe('2026-07-02')
  expect(hm(winter)).toBe('02:30')
})

it('formatting clamps and rounds future and elapsed spans at minute and hour boundaries', () => {
  expect([-60, 29, 30, 3599, 5460].map(until)).toEqual(['0 min', '0 min', '1 min', '1 h 00', '1 h 31'])
  expect([-1, 11, 59.5, 90, 3599, 5520].map(duration)).toEqual(['0s', '11s', '1m', '2m', '1h 0m', '1h 32m'])
  expect([0, 89, 90].map(ago)).toEqual(['just now', 'just now', '2m ago'])
  expect([-1, 1, 3600, 3660, 86400, 90000].map(days)).toEqual(['0m', '1m', '1h', '1h 1m', '1d', '1d 1h'])
})

it('formatting distinguishes missing tiny and rounded monetary values and ratios', () => {
  expect([null, 0, 0.009, 0.01, 1.234, 100.6].map(money)).toEqual(['', '<1c', '<1c', '$0.01', '$1.23', '$101'])
  expect([0.1234, 1.234, 12.34].map(rate)).toEqual(['$0.123', '$1.23', '$12.3'])
  expect([null, 0.314, 4.24, 10.6].map(ratio)).toEqual(['not measured', '0.31×', '4.2×', '11×'])
  expect([999, 1000, 999999, 1000000].map(tokens)).toEqual(['999', '1k', '1000k', '1.0M'])
  expect(pct(42.6)).toBe('43%')
})

it('formatting extracts project names from unix windows and encoded paths', () => {
  expect(['/home/m/git/tally/', 'C:\\git\\tally\\', '-home-m-git-tally', 'C--git-tally', 'plain', '', '/'].map(projectName))
    .toEqual(['tally', 'tally', 'tally', 'tally', 'plain', '', ''])
  expect(labelOn('#ffffff')).toBe('#1c1b19')
  expect(labelOn('#000000')).toBeUndefined()
})
