import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
const originalArgv = [...process.argv]
afterEach(() => { process.argv = [...originalArgv]; vi.restoreAllMocks() })

it('launcher resolves this repo tsx forwards arguments and preserves cwd and signals', async () => {
  vi.resetModules()
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
  mocks.spawn.mockReset().mockReturnValue(child)
  const handlers = new Map<string, (...args: unknown[]) => void>()
  vi.spyOn(process, 'on').mockImplementation((signal, listener) => { handlers.set(String(signal), listener); return process })
  const exit = vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>())
  process.argv = [originalArgv[0]!, '/somewhere/tally', '--port', '0', '--no-open']
  const launcherPath = '../bin/tally.mjs'
  await import(launcherPath)
  const [command, args, options] = mocks.spawn.mock.calls[0] ?? []
  expect(command).toBe(process.execPath)
  expect(args).toEqual(['--import', expect.stringMatching(/\/tsx\/dist\/loader\.mjs$/), join(import.meta.dirname, 'main.ts'), '--port', '0', '--no-open'])
  expect(options).toEqual({ stdio: 'inherit', cwd: process.cwd() })
  handlers.get('SIGINT')?.()
  handlers.get('SIGTERM')?.()
  expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']])
  child.emit('exit', 7, null)
  expect(exit).toHaveBeenLastCalledWith(7)
  child.emit('exit', null, 'SIGTERM')
  expect(exit).toHaveBeenLastCalledWith(1)
  child.emit('exit', null, null)
  expect(exit).toHaveBeenLastCalledWith(0)
})
