import { expect, test } from 'vitest'
import { projectName } from './format'

test('a linux project path or encoded name reads as its last directory', () => {
  expect(projectName('/home/thatmike1/git/ccChat-general')).toBe('ccChat-general')
  expect(projectName('/home/thatmike1/git/tally/')).toBe('tally')
  expect(projectName('-home-thatmike1-git-old-thing')).toBe('thing')
})

test('a windows project path or encoded name reads the same way', () => {
  expect(projectName('I:\\git\\ccChat-general')).toBe('ccChat-general')
  expect(projectName('I:\\git\\tally\\')).toBe('tally')
  expect(projectName('I--git-old-thing')).toBe('thing')
})

test('a plain name is left alone', () => {
  expect(projectName('codex')).toBe('codex')
})
