import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ buildState: vi.fn() }))
vi.mock('./state', () => ({ buildState: mocks.buildState }))
const originalArgv = [...process.argv]
const homes: string[] = []
afterEach(() => {
  process.argv = [...originalArgv]
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

it('demo home produces deterministic three-week samples and matching synthetic transcripts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tally-demo-coverage-'))
  homes.push(home)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-28T12:00:00Z'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  process.argv = [originalArgv[0]!, 'demo-home.mjs', home]
  const scriptPath = '../scripts/demo-home.mjs'
  vi.resetModules()
  await import(scriptPath)
  const logPath = join(home, '.cache', 'tally', 'limits.jsonl')
  const original = readFileSync(logPath, 'utf8')
  const samples = original.trim().split('\n').map((line) => JSON.parse(line))
  expect(samples).toHaveLength(6049)
  expect(samples.at(-1).t - samples[0].t).toBe(21 * 86400)
  expect(samples.every((row, i) => row.src === 'api' && (i === 0 || row.t - samples[i - 1].t === 300))).toBe(true)
  expect(samples.every((row) => row.limits.five_hour.used_percentage >= 0 && row.limits.five_hour.used_percentage <= 100)).toBe(true)
  const projects = join(home, '.claude', 'projects')
  let requests = 0
  for (const project of readdirSync(projects)) {
    expect(project).toMatch(/^-home-demo-git-/)
    for (const name of readdirSync(join(projects, project))) {
      const lines = readFileSync(join(projects, project, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(lines[0]).toMatchObject({ type: 'user', isSidechain: false, cwd: expect.stringMatching(/^\/home\/demo\/git\//) })
      expect(lines.length).toBeGreaterThan(1)
      for (const line of lines.slice(1)) {
        expect(line.type).toBe('assistant')
        expect(line.message.usage).toEqual({ input_tokens: 4, cache_creation_input_tokens: 1200, cache_read_input_tokens: 60000, output_tokens: 400 })
        requests++
      }
    }
  }
  expect(requests).toBeGreaterThan(100)
  vi.resetModules()
  await import(scriptPath)
  expect(readFileSync(logPath, 'utf8')).toBe(original)
})

it('demo home refuses to run without an explicit output directory', async () => {
  process.argv = [originalArgv[0]!, 'demo-home.mjs']
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error('captured exit ' + code) })
  vi.resetModules()
  const scriptPath = '../scripts/demo-home.mjs'
  await expect(import(scriptPath)).rejects.toThrow('captured exit 2')
  expect(console.error).toHaveBeenCalledWith('usage: demo-home.mjs <dir>')
})

// ccChat-general-96mv: keep the stale-field bug visible without changing source
it.fails('state dump omits the removed day.lanesError diagnostic', async () => {
  mocks.buildState.mockResolvedValue({
    fiveHour: { used: 42 }, weekly: null, fable: null, block: { samples: [1, 2] }, notes: ['sample note'], extra: null,
    split: { sessions: [{ title: 'a'.repeat(45), share: 0.12345, points: 2.34, subagents: 2, live: true }], costBeforeFirstSample: 1, costAfterLastSample: 2, totalCost: 3 },
    others: [{ title: 'other agent', kind: 'agy', live: false }], day: { lanes: [1, 2], meter: [1, 2, 3] },
  })
  mocks.buildState.mockClear()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.resetModules()
  const scriptPath = '../scripts/dump-state'
  await import(scriptPath)
  expect(mocks.buildState).toHaveBeenCalledExactlyOnceWith({ recordLook: false })
  expect(JSON.parse(log.mock.calls[0]?.[0])).toEqual({ fiveHour: { used: 42 }, weekly: null, fable: null, block: { samples: 2 }, notes: ['sample note'], extra: null })
  expect(log).toHaveBeenCalledWith('sessions:', [['a'.repeat(40), '0.123', '2.3', 2, true]])
  expect(log).toHaveBeenCalledWith('others:', [['other agent', 'agy', false]])
  expect(log).toHaveBeenCalledWith('lanes:', 2, 'meter points:', 3)
  expect(log).toHaveBeenCalledWith('cost before/after/total:', 1, 2, 3)
})
