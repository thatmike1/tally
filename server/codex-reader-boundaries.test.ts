import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

import { readCodexWeeklyUsage } from './codex-usage'

// a local pipe fixture exercises the real JSON-line reader without launching Codex.
function pipeChild() {
  const writes: object[] = []
  return Object.assign(new EventEmitter(), {
    writes,
    stdin: new Writable({
      write(chunk, _encoding, done) {
        writes.push(JSON.parse(String(chunk)))
        done()
      },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
}

let child: ReturnType<typeof pipeChild>
const sampledAt = 1_800_000_000
const window = { usedPercent: 42.5, resetsAt: sampledAt + 86_400, windowDurationMins: 10_080 }
const reading = { sampledAt, ...window }

function begin(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  return readCodexWeeklyUsage({ binary: '/offline/codex', now: sampledAt, ...options })
}

function reply(message: object) {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

function complete() {
  reply({ id: 1, result: {} })
  reply({ id: 2, result: { rateLimits: { limitId: 'codex', primary: window } } })
}

beforeEach(() => {
  vi.useFakeTimers()
  child = pipeChild()
  mocks.spawn.mockReset().mockReturnValue(child)
})

afterEach(() => {
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Codex allowance JSON-line reader', () => {
  it('starts the selected binary with pipes and the initialization contract', async () => {
    const pending = begin()
    expect(mocks.spawn).toHaveBeenCalledWith('/offline/codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    expect(child.writes).toEqual([{
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'tally', title: 'Tally', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    }])
    complete()
    await expect(pending).resolves.toEqual(reading)
  })

  it('requests account limits only after initialization is acknowledged', async () => {
    const pending = begin()
    reply({ method: 'notification', params: {} })
    expect(child.writes).toHaveLength(1)
    reply({ id: 1, result: {} })
    expect(child.writes.slice(1)).toEqual([
      { method: 'initialized' }, { id: 2, method: 'account/rateLimits/read' },
    ])
    reply({ id: 2, result: { rateLimits: { primary: window } } })
    await expect(pending).resolves.toEqual(reading)
  })

  it('buffers a reply split across multiple stdout chunks until its newline', async () => {
    const pending = begin()
    reply({ id: 1, result: {} })
    const payload = JSON.stringify({ id: 2, result: { rateLimits: { primary: window } } })
    child.stdout.write(payload.slice(0, 17))
    child.stdout.write(payload.slice(17))
    expect(child.kill).not.toHaveBeenCalled()
    child.stdout.write('\n')
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await expect(pending).resolves.toEqual(reading)
  })

  it('skips malformed lines and notifications in a batch containing the valid replies', async () => {
    const pending = begin()
    child.stdout.write([
      'not-json', '', JSON.stringify({ id: 99, result: {} }),
      JSON.stringify({ id: 1, result: {} }), '{broken',
      JSON.stringify({ id: 2, result: { rateLimits: { secondary: window } } }), '',
    ].join('\n'))
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await expect(pending).resolves.toEqual(reading)
  })

  it('selects the Codex weekly bucket from a multi-limit account reply', async () => {
    const pending = begin()
    reply({ id: 1, result: {} })
    reply({ id: 2, result: {
      rateLimits: { limitId: 'other', primary: { ...window, usedPercent: 99 } },
      rateLimitsByLimitId: { codex: {
        limitId: 'codex', primary: { ...window, windowDurationMins: 300 }, secondary: window,
      } },
    } })
    await expect(pending).resolves.toEqual(reading)
  })

  it('reports the initialization error and stops without asking for account data', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('authentication rejected')
    reply({ id: 1, error: { message: 'authentication rejected' } })
    await rejected
    expect(child.writes).toHaveLength(1)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses a useful fallback when initialization returns an error without a message', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('Codex initialization failed')
    reply({ id: 1, error: {} })
    await rejected
  })

  it('reports an account limit request error from the child', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('account rate limited')
    reply({ id: 1, result: {} })
    reply({ id: 2, error: { message: 'account rate limited' } })
    await rejected
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('uses a useful fallback when the account request error omits its message', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('Codex usage request failed')
    reply({ id: 2, error: {} })
    await rejected
  })

  it('rejects a reply that has only a five-hour window instead of inventing a weekly allowance', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('Codex did not report a weekly allowance')
    reply({ id: 2, result: { rateLimits: { primary: { ...window, windowDurationMins: 300 } } } })
    await rejected
  })

  it('reports process startup errors and releases the request timeout', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('could not start Codex: ENOENT')
    child.emit('error', new Error('ENOENT'))
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an early child exit with its exit code', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('Codex exited before reporting usage (7)')
    child.emit('exit', 7)
    await rejected
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('identifies an early signal exit without turning it into a zero exit code', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('Codex exited before reporting usage (signal)')
    child.emit('exit', null)
    await rejected
  })

  it('times out a stalled child at the requested deadline and kills it once', async () => {
    const pending = begin({ timeoutMs: 2_500 })
    const rejected = expect(pending).rejects.toThrow('Codex usage request timed out')
    await vi.advanceTimersByTimeAsync(2_499)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts an active request and unregisters the abort listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = begin({ signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('Codex usage reader stopped')
    controller.abort()
    await rejected
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors an already-aborted signal before writing initialization', async () => {
    const controller = new AbortController()
    controller.abort()
    const pending = begin({ signal: controller.signal })
    await expect(pending).rejects.toThrow('Codex usage reader stopped')
    expect(child.writes).toEqual([])
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it('settles success once and removes the timer and listener before later exit or abort', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = begin({ signal: controller.signal })
    complete()
    await expect(pending).resolves.toEqual(reading)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    child.emit('exit', 0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await expect(pending).resolves.toEqual(reading)
  })

  it('ignores late process events and replies after a failure has settled', async () => {
    const pending = begin()
    const rejected = expect(pending).rejects.toThrow('could not start Codex: offline')
    child.emit('error', new Error('offline'))
    await rejected
    child.emit('exit', 1)
    reply({ id: 2, result: { rateLimits: { primary: window } } })
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(vi.getTimerCount()).toBe(0)
    await expect(pending).rejects.toThrow('could not start Codex: offline')
  })
})
