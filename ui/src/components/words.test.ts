import { expect, it } from 'vitest'
import { activeLabel, activeWithin, capital, clip, countWord, effortLevels, listOf, modelName, plural, points, realModels, rowName, rowSubtitle, sentenceName, share, steepestClimb, timesWord } from './words'

it('word helpers preserve real model IDs while removing synthetic placeholders', () => {
  expect(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-6.1-sol', 'custom'].map(modelName))
    .toEqual(['opus 5.5', 'haiku 4.5', 'gpt-6.1-sol', 'custom'])
  expect(realModels([{ model: '<synthetic>' }, { model: 'claude-opus-5-5' }, { model: '<error>' }])).toEqual([{ model: 'claude-opus-5-5' }])
})

it('word helpers join lists and distinguish counts and plural requests', () => {
  expect([[], ['a'], ['a', 'b'], ['a', 'b', 'c']].map(listOf)).toEqual(['', 'a', 'a and b', 'a, b and c'])
  expect(['', 'hello'].map(capital)).toEqual(['', 'Hello'])
  expect([0, 3, 12].map(countWord)).toEqual(['no', 'three', '12'])
  expect([1, 2, 3, 12].map(timesWord)).toEqual(['once', 'twice', 'three times', '12 times'])
  expect(plural(1, 'request')).toBe('1 request')
  expect(plural(1000, 'request')).toBe('1,000 requests')
  expect([null, 0, 0.64, 4.6].map(points)).toEqual(['', '~0.0', '~0.6', '~5'])
  expect([0, 0.001, 0.005, 0.416].map(share)).toEqual(['0%', '<1%', '1%', '42%'])
})

it('row names prefer T3 titles then clipped prompts then short session IDs', () => {
  const row = { shortTitle: 'named thread', title: '  one   two three four five six seven eight', sessionId: '1234567890abcdef', project: '/git/project' }
  expect(rowName(row)).toBe('named thread')
  expect(sentenceName(row)).toBe('named thread')
  expect(rowSubtitle(row)).toBe(row.title)
  expect(rowName({ ...row, shortTitle: null, title: 'a'.repeat(60) })).toBe('a'.repeat(55) + '…')
  expect(sentenceName({ ...row, shortTitle: null })).toBe('“one two three four five six…”')
  expect(sentenceName({ ...row, shortTitle: null, title: 'short prompt' })).toBe('“short prompt”')
  expect(sentenceName({ ...row, shortTitle: null, title: 'a'.repeat(50) })).toBe('“' + 'a'.repeat(39) + '…”')
  expect(rowSubtitle({ ...row, shortTitle: null })).toBe('project')
  expect(rowName({ ...row, shortTitle: null, title: null })).toBe('12345678')
  expect(sentenceName({ ...row, shortTitle: null, title: null })).toBe('12345678')
  expect(clip('  one\n two  ', 7)).toBe('one two')
  expect(clip('one two three', 8)).toBe('one two…')
})

it('activity totals use overlap rather than full segment spans and omit unknown effort', () => {
  expect(activeWithin([{ start: 0, end: 5 }, { start: 10, end: 30 }, { start: 50, end: 60 }], 15, 40)).toBe(15)
  expect(activeWithin([], 15, 40)).toBe(0)
  expect(activeLabel(59)).toBe('<1m')
  expect(activeLabel(60)).toBe('1m')
  expect(effortLevels({ effort: [{ effort: null, requests: 2 }, { effort: 'high', requests: 3 }] })).toEqual(['high'])
})

it('steepest climb selects the greatest positive rise within the time span', () => {
  expect(steepestClimb([])).toBeNull()
  expect(steepestClimb([{ t: 0, pct: 10 }, { t: 1, pct: 5 }])).toBeNull()
  expect(steepestClimb([{ t: 0, pct: 0 }, { t: 10, pct: 3 }, { t: 20, pct: 10 }, { t: 40, pct: 90 }], 20))
    .toEqual({ from: 20, to: 40, startPct: 10, endPct: 90, rise: 80 })
  expect(steepestClimb([{ t: 0, pct: 0 }, { t: 2101, pct: 90 }])).toBeNull()
})
