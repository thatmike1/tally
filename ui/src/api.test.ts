import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentsview, ApiError, errorLine, fetchCodexHistory, fetchHistory, fetchSession, fetchState, fetchStateAt } from './api'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
afterEach(() => vi.unstubAllGlobals())

it('api builds the state queries without moving the marker for peek or history', async () => {
  fetchMock.mockImplementation(async () => Response.json({ now: 42 }))
  expect(await fetchState(false)).toEqual({ now: 42 })
  await fetchState(true)
  await fetchState(false, 'whole')
  await fetchState(true, 'whole')
  await fetchStateAt(12.6)
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/state', '/api/state?peek', '/api/state?week=whole', '/api/state?peek&week=whole', '/api/state?at=13&peek',
  ])
})

it('api encodes session identifiers and preserves an explicit zero freeze time', async () => {
  fetchMock.mockImplementation(async () => Response.json({ sessionId: 'test' }))
  await fetchSession('codex:a/b ?')
  await fetchSession('codex:a/b ?', 0)
  await fetchSession('id', 1.6)
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/session/codex%3Aa%2Fb%20%3F', '/api/session/codex%3Aa%2Fb%20%3F?at=0', '/api/session/id?at=2',
  ])
})

it('api reads both history endpoints and returns the parsed bodies', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ blocks: ['claude'] })).mockResolvedValueOnce(Response.json({ windows: ['codex'] }))
  expect(await fetchHistory()).toEqual({ blocks: ['claude'] })
  expect(await fetchCodexHistory()).toEqual({ windows: ['codex'] })
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/history', '/api/history/codex'])
})

it('api errors preserve status and the server message with a fallback for non-json bodies', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'missing session' }, { status: 404 }))
    .mockResolvedValueOnce(new Response('upstream down', { status: 502 }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
  await expect(fetchSession('missing')).rejects.toMatchObject({ name: 'ApiError', status: 404, message: 'missing session' })
  await expect(fetchHistory()).rejects.toEqual(new ApiError(502, 'tally server answered 502'))
  await expect(fetchHistory()).rejects.toMatchObject({ status: 503, message: 'tally server answered 503' })
})

it('api propagates transport failures and formats unknown problems without inventing links', async () => {
  const error = new Error('offline')
  fetchMock.mockRejectedValueOnce(error)
  await expect(fetchHistory()).rejects.toBe(error)
  expect(errorLine(error)).toBe('offline')
  expect(errorLine(null)).toBe('null')
  expect(errorLine('plain problem')).toBe('plain problem')
  expect(agentsview(null, 'id')).toBeNull()
  expect(agentsview('https://viewer.test', 'id')).toBe('https://viewer.test/sessions/id?msg=last')
})
