// tests for running the sampler without systemd: the wall-clock schedule, the
// python pick and the one-run-at-a-time rule.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootedBySystemd,
  interpreterCandidates,
  nextMark,
  pickInterpreter,
  runScript,
  scheduleSampler,
  type Interpreter,
} from './sampler'

/** 19:05:00 UTC on 27 Sep 2026, a five-minute mark */
const MARK = 1790528700

describe('bootedBySystemd', () => {
  it('is systemd only on a linux that systemd booted', () => {
    const booted = (path: string) => path === '/run/systemd/system'
    expect(bootedBySystemd('linux', booted)).toBe(true)
    expect(bootedBySystemd('linux', () => false)).toBe(false)
    expect(bootedBySystemd('win32', booted)).toBe(false)
  })
})

describe('nextMark', () => {
  it('is the next wall-clock five minutes, never the current instant', () => {
    expect(nextMark(MARK - 1)).toBe(MARK)
    expect(nextMark(MARK)).toBe(MARK + 300)
    expect(nextMark(MARK + 0.5)).toBe(MARK + 300)
  })
})

describe('the python pick', () => {
  it('tries the config, then python, then the py launcher on windows', () => {
    expect(interpreterCandidates('C:\\Python311\\python.exe', 'win32')).toEqual([
      { command: 'C:\\Python311\\python.exe', args: [] },
      { command: 'python', args: [] },
      { command: 'py', args: ['-3'] },
    ])
    expect(interpreterCandidates(null, 'win32')).toEqual([
      { command: 'python', args: [] },
      { command: 'py', args: ['-3'] },
    ])
  })

  it('tries python3 before python elsewhere', () => {
    expect(interpreterCandidates(null, 'darwin').map((c) => c.command)).toEqual(['python3', 'python'])
  })

  it('skips a candidate that does not answer as python 3, like the store stub', () => {
    const answers = new Set(['py'])
    const picked = pickInterpreter(interpreterCandidates(null, 'win32'), (c: Interpreter) => answers.has(c.command))
    expect(picked).toEqual({ command: 'py', args: ['-3'] })
    expect(pickInterpreter(interpreterCandidates(null, 'win32'), () => false)).toBeNull()
  })
})

describe('scheduleSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** a run that stays in flight until the test lets it finish */
  function runs() {
    const pending: (() => void)[] = []
    let count = 0
    const run = () => {
      count++
      return new Promise<void>((resolve) => pending.push(resolve))
    }
    return { run, count: () => count, finish: () => pending.splice(0).forEach((resolve) => resolve()) }
  }

  it('runs on the five-minute marks and not in between', async () => {
    vi.setSystemTime((MARK + 100) * 1000)
    const r = runs()
    const sampler = scheduleSampler({ run: r.run, lastRead: () => MARK + 90 })
    // a reading ten seconds old needs no catch-up
    expect(r.count()).toBe(0)
    await vi.advanceTimersByTimeAsync(199_000)
    expect(r.count()).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.count()).toBe(1)
    r.finish()
    await vi.advanceTimersByTimeAsync(299_000)
    expect(r.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.count()).toBe(2)
    sampler.stop()
  })

  it('catches up at startup when the last reading is a period old or missing', () => {
    vi.setSystemTime((MARK + 100) * 1000)
    const stale = runs()
    scheduleSampler({ run: stale.run, lastRead: () => MARK + 100 - 300 }).stop()
    expect(stale.count()).toBe(1)
    const never = runs()
    scheduleSampler({ run: never.run, lastRead: () => null }).stop()
    expect(never.count()).toBe(1)
  })

  it('skips a mark that comes while a run is still in flight, and a kick too', async () => {
    vi.setSystemTime((MARK - 1) * 1000)
    const r = runs()
    const sampler = scheduleSampler({ run: r.run, lastRead: () => MARK - 10 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.count()).toBe(1)
    sampler.kick()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(r.count()).toBe(1)
    r.finish()
    await vi.advanceTimersByTimeAsync(0)
    sampler.kick()
    expect(r.count()).toBe(2)
    sampler.stop()
  })

  it('runs once after a sleep that skipped marks, then goes back on the grid', async () => {
    vi.setSystemTime((MARK + 10) * 1000)
    const r = runs()
    const sampler = scheduleSampler({ run: r.run, lastRead: () => MARK })
    // the machine sleeps for twenty minutes: the wall clock jumps, no timer fires
    vi.setSystemTime((MARK + 1210) * 1000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.count()).toBe(1)
    r.finish()
    // woke at +1210, ran within a minute; the next run is the +1500 mark, not a backlog
    await vi.advanceTimersByTimeAsync((1499 - 1270) * 1000)
    expect(r.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.count()).toBe(2)
    sampler.stop()
  })

  it('stops', async () => {
    vi.setSystemTime((MARK + 100) * 1000)
    const r = runs()
    const sampler = scheduleSampler({ run: r.run, lastRead: () => MARK + 90 })
    sampler.stop()
    await vi.advanceTimersByTimeAsync(3_600_000)
    sampler.kick()
    expect(r.count()).toBe(0)
  })
})

describe('runScript', () => {
  it('runs the script with the interpreter and resolves once it has exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-sampler-'))
    const script = join(dir, 'sample.mjs')
    const out = join(dir, 'ran')
    writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, 'yes')\n`)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runScript({ command: process.execPath, args: [] }, script)
    expect(existsSync(out)).toBe(true)
    expect(log.mock.calls.some(([line]) => String(line).startsWith('tally: sampler ran'))).toBe(true)
    log.mockRestore()
  })

  it('says why when the script fails, and still resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-sampler-'))
    const script = join(dir, 'fail.mjs')
    writeFileSync(script, `console.error('no credentials'); process.exit(1)\n`)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runScript({ command: process.execPath, args: [] }, script)
    expect(error.mock.calls.some(([line]) => /exited 1.*\n.*no credentials/s.test(String(line)))).toBe(true)
    error.mockRestore()
  })
})
