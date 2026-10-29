import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), readLog: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))
vi.mock('./samples', () => ({ readLog: mocks.readLog }))
import { answersAsPython3, inProcessSampler, runScript, SAMPLER_SCRIPT, systemdSampler } from './sampler'

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

it('systemd sampler requests only the user unit and reports spawn failure', () => {
  const process = child()
  mocks.spawn.mockReturnValue(process)
  const sampler = systemdSampler()
  sampler.kick()
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith('systemctl', ['--user', 'start', '--no-block', 'tally-sampler.service'], { stdio: 'ignore' })
  process.emit('error', new Error('offline'))
  expect(console.error).toHaveBeenCalledWith('tally: could not start tally-sampler.service')
  sampler.stop()
})

it('python probes accept only a successful Python 3 version from stdout or stderr', () => {
  mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: 'Python 3.12.0\n', stderr: '' })
    .mockReturnValueOnce({ status: 0, stdout: '', stderr: 'Python 3.10.9\n' })
    .mockReturnValueOnce({ status: 0, stdout: 'Python 2.7.0', stderr: '' })
    .mockReturnValueOnce({ status: 9009, stdout: 'Python 3.0', stderr: '' })
  const python = { command: 'py', args: ['-3'] }
  expect([0, 1, 2, 3].map(() => answersAsPython3(python))).toEqual([true, true, false, false])
  expect(mocks.spawnSync).toHaveBeenCalledWith('py', ['-3', '--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
})

it('sampler run kills a stuck child at four minutes and resolves on close', async () => {
  const process = child()
  mocks.spawn.mockReturnValue(process)
  let done = false
  const run = runScript({ command: 'python3', args: [] }).then(() => { done = true })
  await vi.advanceTimersByTimeAsync(239_999)
  expect(process.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(process.kill).toHaveBeenCalledOnce()
  expect(done).toBe(false)
  process.emit('close', null, 'SIGTERM')
  await run
  expect(console.error).toHaveBeenCalledWith('tally: sampler exited SIGTERM after 240.0s')
  expect(vi.getTimerCount()).toBe(0)
})

it('sampler spawn failures resolve and clear the kill timer', async () => {
  const process = child()
  mocks.spawn.mockReturnValue(process)
  const run = runScript({ command: 'missing-python', args: [] })
  process.emit('error', new Error('ENOENT'))
  await run
  expect(console.error).toHaveBeenCalledWith('tally: could not run the sampler: ENOENT')
  expect(vi.getTimerCount()).toBe(0)
})

it('in-process sampler stays inert when no candidate answers as Python 3', async () => {
  mocks.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' })
  const sampler = inProcessSampler('/missing-python')
  sampler.kick()
  await vi.advanceTimersByTimeAsync(600_000)
  sampler.stop()
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no python 3 found'))
})

it('in-process sampler falls back from the configured interpreter and runs only when stale', async () => {
  mocks.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValue({ status: 0, stdout: 'Python 3.12.0' })
  mocks.readLog.mockReturnValue({ lastRead: 0 })
  const process = child()
  mocks.spawn.mockReturnValue(process)
  const sampler = inProcessSampler('/bad-python', '/isolated/log.jsonl')
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sampler falls back'))
  expect(mocks.readLog).toHaveBeenCalledWith('/isolated/log.jsonl')
  expect(mocks.spawn).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300_000)
  expect(mocks.spawn).toHaveBeenCalledWith('python3', [SAMPLER_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  process.emit('close', 0, null)
  await vi.advanceTimersByTimeAsync(0)
  sampler.stop()
  expect(vi.getTimerCount()).toBe(0)
})
