import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), closeIndex: vi.fn(), createApp: vi.fn(), serve: vi.fn(), spawn: vi.fn(), buildState: vi.fn(),
  booted: vi.fn(), systemd: vi.fn(), inProcess: vi.fn(), kick: vi.fn(), stopSampler: vi.fn(),
  codex: vi.fn(), stopCodex: vi.fn(), writeWidget: vi.fn(), removeWidget: vi.fn(), closeServer: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('@hono/node-server', () => ({ serve: mocks.serve }))
vi.mock('./app', () => ({ createApp: mocks.createApp }))
vi.mock('./codex-usage', () => ({ startCodexUsageReader: mocks.codex }))
vi.mock('./config', () => ({ defaultConfig: () => ({ port: 1337 }), tallyConfig: () => ({ port: 1444, python: '/configured/python' }) }))
vi.mock('./sampler', () => ({ bootedBySystemd: mocks.booted, systemdSampler: mocks.systemd, inProcessSampler: mocks.inProcess }))
vi.mock('./state', () => ({ buildState: mocks.buildState }))
vi.mock('./transcript-index', () => ({ TranscriptIndex: class { refresh = mocks.refresh; close = mocks.closeIndex } }))
vi.mock('./widget', () => ({ writeWidget: mocks.writeWidget, removeWidget: mocks.removeWidget }))

const counts = { seen: 4, parsed: 1, skipped: 3, dropped: 0, failed: 0, records: 2, reread: 0, stale: 0, seconds: 0.1 }
const handlers = new Map<string, (...args: unknown[]) => void>()
const originalArgv = [...process.argv]
const opener = Object.assign(new EventEmitter(), { unref: vi.fn() })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  handlers.clear()
  opener.removeAllListeners()
  mocks.refresh.mockReset().mockResolvedValue(counts)
  mocks.createApp.mockReturnValue({ fetch: () => new Response('test') })
  mocks.booted.mockReturnValue(true)
  mocks.systemd.mockReturnValue({ kick: mocks.kick, stop: mocks.stopSampler })
  mocks.inProcess.mockReturnValue({ kick: mocks.kick, stop: mocks.stopSampler })
  mocks.codex.mockReturnValue({ stop: mocks.stopCodex })
  mocks.buildState.mockReset().mockResolvedValue({ now: 200, fiveHour: { ended: true, ageSeconds: 50, resetsAt: 180 } })
  mocks.spawn.mockReturnValue(opener)
  mocks.closeServer.mockImplementation((done: () => void) => done())
  mocks.serve.mockImplementation((_options: unknown, callback: (info: { port: number }) => void) => {
    callback({ port: 4567 })
    return { close: mocks.closeServer }
  })
  vi.spyOn(process, 'on').mockImplementation((signal, listener) => { handlers.set(String(signal), listener); return process })
  vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>())
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  process.argv = [...originalArgv]
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function boot(args: string[] = []) {
  process.argv = [originalArgv[0]!, fileURLToPath(new URL('./main.ts', import.meta.url)), ...args]
  const module = await import('./main')
  await vi.advanceTimersByTimeAsync(0)
  return module
}

it('main options honor configured defaults explicit ports and rejection boundaries', async () => {
  const { parseOptions } = await import('./main')
  expect(parseOptions([])).toEqual({ port: 1337, open: true, widget: true })
  expect(parseOptions([], 1444).port).toBe(1444)
  expect(parseOptions(['--port', '0', '--no-open', '--no-widget'], 1444)).toEqual({ port: 0, open: false, widget: false })
  expect(() => parseOptions(['--port', '65535'])).not.toThrow()
  expect(parseOptions(['--port', '65535']).port).toBe(65535)
  for (const port of ['-1', '65536', '1.5', 'NaN']) expect(() => parseOptions(['--port=' + port])).toThrow('--port must be between 0 and 65535')
  expect(() => parseOptions(['--unknown'])).toThrow()
})

it('main binds localhost opens the returned URL and releases resources on shutdown', async () => {
  await boot()
  expect(mocks.serve).toHaveBeenCalledWith({ fetch: expect.any(Function), hostname: '127.0.0.1', port: 1444 }, expect.any(Function))
  expect(mocks.spawn).toHaveBeenCalledWith('xdg-open', ['http://127.0.0.1:4567/'], { stdio: 'ignore', detached: true })
  expect(opener.unref).toHaveBeenCalledOnce()
  opener.emit('error', new Error('missing opener'))
  expect(console.error).toHaveBeenCalledWith('tally: could not run xdg-open; open the url yourself')
  expect(mocks.writeWidget).toHaveBeenCalled()
  expect(mocks.kick).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.kick).toHaveBeenCalledOnce()
  handlers.get('SIGTERM')?.()
  expect(mocks.stopSampler).toHaveBeenCalledOnce()
  expect(mocks.stopCodex).toHaveBeenCalledOnce()
  expect(mocks.closeIndex).toHaveBeenCalledOnce()
  expect(mocks.removeWidget).toHaveBeenCalledOnce()
  expect(mocks.closeServer).toHaveBeenCalledOnce()
  expect(process.exit).toHaveBeenCalledWith(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('main disabled browser and widget still index while an index pass is in flight', async () => {
  let finish: ((value: typeof counts) => void) | undefined
  mocks.refresh.mockImplementation(() => new Promise<typeof counts>((resolve) => { finish = resolve }))
  await boot(['--port', '0', '--no-open', '--no-widget'])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.refresh).toHaveBeenCalledOnce()
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(mocks.writeWidget).not.toHaveBeenCalled()
  finish?.(counts)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.refresh).toHaveBeenCalledTimes(2)
  handlers.get('SIGINT')?.()
  expect(mocks.removeWidget).not.toHaveBeenCalled()
})

it('main chooses in-process sampling and logs failed and stale index passes', async () => {
  mocks.booted.mockReturnValue(false)
  mocks.refresh.mockReset().mockRejectedValueOnce(new Error('index unavailable'))
    .mockResolvedValueOnce({ ...counts, failed: 2, stale: 1, reread: 3 })
    .mockResolvedValue(counts)
  await boot(['--no-open'])
  expect(mocks.inProcess).toHaveBeenCalledWith('/configured/python')
  expect(mocks.systemd).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledWith('tally: index pass failed: index unavailable')
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.refresh.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 failed'))
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('3 reread for a new field (1 to go)'))
  mocks.buildState.mockRejectedValueOnce(new Error('state unavailable'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(console.error).toHaveBeenCalledWith('tally: minute tick failed: state unavailable')
})
