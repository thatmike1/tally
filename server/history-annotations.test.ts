import { expect, it } from 'vitest'
import { annotationsFor, HISTORY_ANNOTATIONS } from './history-annotations'
import { claudeHistory } from './history-claude'

it('serves documented annotations even with no meter readings', async () => {
  const history = await claudeHistory({ home: '/nonexistent/tally-test', now: 1794560000 })
  expect(history.annotations).toEqual(HISTORY_ANNOTATIONS)
})

it('marks the transition week but not the first fully fixed week, with exclusive boundaries', () => {
  const nov7 = Date.parse('2026-11-07T22:00:00+01:00') / 1000
  const week = 7 * 86400
  expect(annotationsFor(HISTORY_ANNOTATIONS, nov7 - week, nov7)).toHaveLength(1)
  expect(annotationsFor(HISTORY_ANNOTATIONS, nov7, nov7 + week)).toHaveLength(0)
  const event = HISTORY_ANNOTATIONS[0]!
  expect(annotationsFor([event], event.end, event.end + 1)).toHaveLength(0)
  expect(annotationsFor([event], event.start - 1, event.start)).toHaveLength(0)
})
