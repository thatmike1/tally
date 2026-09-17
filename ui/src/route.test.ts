import { expect, test } from 'vitest'
import { blockHref, parseRoute, sessionHref, weekHref } from './route'

test('an empty or unknown hash is today', () => {
  expect(parseRoute('')).toEqual({ kind: 'today' })
  expect(parseRoute('#')).toEqual({ kind: 'today' })
  expect(parseRoute('#/')).toEqual({ kind: 'today' })
  expect(parseRoute('#/nonsense/deep')).toEqual({ kind: 'today' })
})

test('the history routes carry their window key', () => {
  expect(parseRoute('#/history')).toEqual({ kind: 'history' })
  expect(parseRoute('#/history/')).toEqual({ kind: 'history' })
  expect(parseRoute(blockHref(1757700000))).toEqual({ kind: 'block', resetKey: 1757700000 })
  expect(parseRoute(weekHref(1757703600))).toEqual({ kind: 'week', resetsAt: 1757703600 })
})

test('a window key that is not a number falls back to the overview', () => {
  expect(parseRoute('#/history/block/soon')).toEqual({ kind: 'history' })
  expect(parseRoute('#/history/block')).toEqual({ kind: 'history' })
  expect(parseRoute('#/history/quarter/12')).toEqual({ kind: 'history' })
})

test('a session id survives the round trip, encoded or not', () => {
  expect(parseRoute('#/session/abc-123')).toEqual({ kind: 'session', id: 'abc-123' })
  expect(parseRoute(sessionHref('a b/c'))).toEqual({ kind: 'session', id: 'a b/c' })
})

test('a frozen session link carries its instant, and a bad one falls back to the live session', () => {
  expect(parseRoute(sessionHref('codex:01a0', 1789062400.4))).toEqual({ kind: 'session', id: 'codex:01a0', at: 1789062400 })
  expect(parseRoute('#/session/codex:01a0/soon')).toEqual({ kind: 'session', id: 'codex:01a0' })
})
