// the day labels under a history chart thin out to fit the column they sit in
import { describe, expect, it } from 'vitest'
import { dayTicks } from './charts'

const DAY = 86400
// Fri 2 Oct 2026 00:00 in Prague
const FROM = Date.UTC(2026, 9, 1, 22) / 1000

describe('dayTicks', () => {
  it('keeps at most nine labels on a wide chart', () => {
    expect(dayTicks(FROM, FROM + 21 * DAY, 1400).length).toBeLessThanOrEqual(9)
  })

  it('keeps a label per 80 pixels on a narrow one', () => {
    expect(dayTicks(FROM, FROM + 21 * DAY, 260).length).toBeLessThanOrEqual(3)
  })

  it('labels every day of a short span that fits', () => {
    expect(dayTicks(FROM + 3600, FROM + 4 * DAY + 3600, 1400)).toHaveLength(4)
  })
})

it('renders the known era as a labelled band on the weekly chart', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { CostPerPercentChart } = await import('./charts')
  const { claudeHistory } = await import('../../../server/history-claude')
  const { HISTORY_ANNOTATIONS } = await import('../../../server/history-annotations')
  const history = await claudeHistory({ home: '/nonexistent/tally-test', now: 1794560000 })
  history.since = HISTORY_ANNOTATIONS[0]!.start - 86400
  const html = renderToStaticMarkup(createElement(CostPerPercentChart, { history }))
  expect(html).toContain('T3 entrypoint penalty')
  expect(html).toContain('opacity="0.05"')
  expect(html).toContain('laptop fixed 5 Nov')
})
