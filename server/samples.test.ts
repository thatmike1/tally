// the meter log: which rows count, how blocks are keyed, what stale means.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blocks, currentBlock, limitsLogPath, monotonic, readLog, readSamples, type Sample } from './samples'

function logWith(rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tally-samples-'))
  const path = join(dir, 'limits.jsonl')
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return path
}

function apiRow(t: number, pct: number, resetsAt: number, extra: Record<string, unknown> = {}) {
  return {
    t,
    src: 'api',
    limits: { five_hour: { used_percentage: pct, resets_at: resetsAt }, seven_day: { used_percentage: 40, resets_at: resetsAt + 86400 } },
    scoped: [{ model: 'Fable', percent: 12, resets_at: resetsAt + 86400 }],
    ...extra,
  }
}

describe('limitsLogPath', () => {
  function homeWith(...dirs: string[]): string {
    const home = mkdtempSync(join(tmpdir(), 'tally-home-'))
    for (const dir of dirs) {
      mkdirSync(join(home, '.cache', dir), { recursive: true })
      writeFileSync(join(home, '.cache', dir, 'limits.jsonl'), '')
    }
    return home
  }

  it('reads the log the old sampler left behind when nothing has moved yet', () => {
    const home = homeWith('cc-browse-tray')
    expect(limitsLogPath(home)).toBe(join(home, '.cache', 'cc-browse-tray', 'limits.jsonl'))
  })

  it('prefers the new path once install.sh has moved the log', () => {
    const home = homeWith('cc-browse-tray', 'tally')
    expect(limitsLogPath(home)).toBe(join(home, '.cache', 'tally', 'limits.jsonl'))
  })

  it('names the new path on a machine with no log at all, which is where the sampler will write', () => {
    const home = homeWith()
    expect(limitsLogPath(home)).toBe(join(home, '.cache', 'tally', 'limits.jsonl'))
  })
})

describe('readSamples', () => {
  it('drops everything that is not an api row', () => {
    const path = logWith([
      apiRow(100, 10, 18000),
      // the statusline hook writes no `src`; an idle tab republishes a stale number
      { t: 120, limits: { five_hour: { used_percentage: 3, resets_at: 18000 } } },
      { t: 130, src: 'statusline', limits: { five_hour: { used_percentage: 99, resets_at: 18000 } } },
    ])
    const samples = readSamples(path)
    expect(samples.map((s) => s.pct)).toEqual([10])
  })

  it('skips a row with no five-hour reset', () => {
    const path = logWith([{ t: 1, src: 'api', limits: { seven_day: { used_percentage: 4, resets_at: 9 } } }])
    expect(readSamples(path)).toEqual([])
  })

  it('keeps unmodelled fields instead of dropping them', () => {
    const path = logWith([apiRow(100, 10, 18000, { boost: { multiplier: 1.5 } })])
    expect(readSamples(path)[0]!.unknown).toEqual({ boost: { multiplier: 1.5 } })
  })

  it('carries the scoped meter and the paid overflow', () => {
    const path = logWith([apiRow(100, 10, 18000, { extra: { used: 46, limit: 100, currency: 'EUR' } })])
    const sample = readSamples(path)[0]!
    expect(sample.scoped[0]).toEqual({ model: 'Fable', pct: 12, resetsAt: 18000 + 86400 })
    expect(sample.extra).toEqual({ used: 46, limit: 100, currency: 'EUR' })
  })

  it('carries other limits and raw extra without putting them in unknown', () => {
    const path = logWith([
      apiRow(100, 10, 18000, {
        other_limits: [{ kind: 'session', percent: 10 }],
        raw_extra: { tangelo: null },
      }),
    ])
    const sample = readSamples(path)[0]!
    expect(sample.otherLimits).toEqual([{ kind: 'session', percent: 10 }])
    expect(sample.rawExtra).toEqual({ tangelo: null })
    expect(sample.unknown).toEqual({})
  })

  it('survives a truncated last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-samples-'))
    const path = join(dir, 'limits.jsonl')
    writeFileSync(path, `${JSON.stringify(apiRow(100, 10, 18000))}\n{"t":101,"src":"api","lim`)
    expect(readSamples(path)).toHaveLength(1)
  })

  it('returns nothing when the log is missing', () => {
    expect(readSamples('/nope/limits.jsonl')).toEqual([])
  })
})

describe('blocks', () => {
  it('keys on the reset minute, so a one-second jitter stays one block', () => {
    const path = logWith([apiRow(100, 10, 18_000), apiRow(400, 12, 17_999), apiRow(700, 14, 18_000)])
    const grouped = blocks(readSamples(path))
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.samples).toHaveLength(3)
    expect(grouped[0]!.start).toBe(18_000 - 5 * 3600)
  })

  it('splits two different resets', () => {
    const path = logWith([apiRow(100, 90, 18_000), apiRow(400, 5, 36_000)])
    expect(blocks(readSamples(path)).map((b) => b.resetKey)).toEqual([18_000, 36_000])
  })
})

describe('monotonic', () => {
  it('drops a reading that went down', () => {
    const rows = [10, 12, 11, 15, 14, 15].map((pct, i) => ({ t: i, pct }) as Sample)
    expect(monotonic(rows).map((r) => r.pct)).toEqual([10, 12, 15, 15])
  })
})

describe('currentBlock', () => {
  const path = logWith([apiRow(1000, 10, 18_000), apiRow(2000, 9, 18_000), apiRow(3000, 30, 18_000)])
  const current = currentBlock(blocks(readSamples(path)), 4000)!

  it('measures the delta over the monotonic span only', () => {
    expect(current.delta).toBe(20)
    expect(current.first.t).toBe(1000)
    expect(current.last.t).toBe(3000)
    expect(current.maxGap).toBe(2000)
  })

  it('reports how stale the reading is', () => {
    expect(current.sampleAge).toBe(1000)
    expect(current.expired).toBe(false)
    expect(currentBlock(blocks(readSamples(path)), 20_000)!.expired).toBe(true)
  })

  it('treats a passed reset as a finished block, not a stale sampler', () => {
    // right after a reset the endpoint reports 0% with no resets_at until the next message
    const idle = { t: 18_010, src: 'api', limits: { five_hour: { used_percentage: 0, resets_at: null } } }
    const log = readLog(logWith([apiRow(1000, 10, 18_000), apiRow(3000, 30, 18_000), idle]))
    expect(log.samples).toHaveLength(2)
    expect(log.lastRead).toBe(18_010)
    const after = currentBlock(blocks(log.samples), 18_070, log.lastRead)!
    expect(after.ended).toBe(true)
    expect(after.expired).toBe(false)
    expect(after.sampleAge).toBe(60)
  })

  it('gives a reset that was never read ten minutes before calling the sampler behind', () => {
    const all = blocks(readSamples(path))
    expect(currentBlock(all, 18_300)!.expired).toBe(false)
    expect(currentBlock(all, 18_000 + 601)!.expired).toBe(true)
  })

  it('flags saturation, because movement after 100% is censored', () => {
    const saturated = logWith([apiRow(1000, 80, 18_000), apiRow(2000, 100, 18_000)])
    expect(currentBlock(blocks(readSamples(saturated)), 2500)!.saturated).toBe(true)
  })

  it('has nothing to say about an empty log', () => {
    expect(currentBlock([], 10)).toBeNull()
  })
})
