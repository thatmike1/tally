import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_STALE_SECONDS,
  codexBinaryPath,
  codexUsageView,
  readCodexHistory,
  recordCodexFailure,
  recordCodexReading,
  selectCodexWeeklyWindow,
  type CodexUsagePaths,
} from './codex-usage'

function paths(): CodexUsagePaths {
  const dir = mkdtempSync(join(tmpdir(), 'tally-codex-'))
  return { history: join(dir, 'history.jsonl'), status: join(dir, 'status.json') }
}

describe('selectCodexWeeklyWindow', () => {
  it('selects a seven-day window from the main bucket regardless of position', () => {
    const reading = selectCodexWeeklyWindow(
      {
        rateLimits: { limitId: 'other', secondary: { usedPercent: 90, resetsAt: 200, windowDurationMins: 10_080 } },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 2, resetsAt: 150, windowDurationMins: 300 },
            secondary: { usedPercent: 41.6, resetsAt: 900, windowDurationMins: 10_080 },
          },
        },
      },
      100,
    )
    expect(reading).toEqual({ sampledAt: 100, usedPercent: 41.6, resetsAt: 900, windowDurationMins: 10_080 })
  })

  it('does not infer weekly from primary or secondary position', () => {
    expect(selectCodexWeeklyWindow({ rateLimits: { secondary: { usedPercent: 2, resetsAt: 900 } } }, 100)).toBeNull()
  })
})

describe('codexBinaryPath', () => {
  it('finds a user-level Bun install when the service PATH does not include it', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-home-'))
    const binary = join(home, '.bun', 'bin', 'codex')
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true })
    writeFileSync(binary, '')
    expect(codexBinaryPath(home, { PATH: '/usr/bin' })).toBe(binary)
  })
})

describe('Codex usage history and view', () => {
  it('records timestamped readings and formats the glance line', () => {
    const files = paths()
    recordCodexReading(files, { sampledAt: 100, usedPercent: 1.2, resetsAt: 100 + 6 * 86_400 + 22 * 3600, windowDurationMins: 10_080 })
    expect(readCodexHistory(files.history)).toHaveLength(1)
    expect(codexUsageView(files, 100)).toMatchObject({
      status: 'fresh',
      line: 'Codex · 1% used · resets in 6d 22h',
      usedPercent: 1.2,
    })
  })

  it('does not present a failed read as zero or as fresh old data', () => {
    const files = paths()
    recordCodexReading(files, { sampledAt: 100, usedPercent: 42, resetsAt: 10_000, windowDurationMins: 10_080 })
    recordCodexFailure(files, 110, 'offline')
    expect(codexUsageView(files, 120)).toMatchObject({ status: 'stale', usedPercent: null })
    expect(codexUsageView(files, 120).line).not.toContain('0%')
  })

  it('marks old readings stale and hides a percentage after reset', () => {
    const staleFiles = paths()
    recordCodexReading(staleFiles, { sampledAt: 100, usedPercent: 42, resetsAt: 10_000, windowDurationMins: 10_080 })
    expect(codexUsageView(staleFiles, 100 + CODEX_STALE_SECONDS + 1)).toMatchObject({ status: 'stale', usedPercent: null })

    const resetFiles = paths()
    recordCodexReading(resetFiles, { sampledAt: 100, usedPercent: 99, resetsAt: 200, windowDurationMins: 10_080 })
    expect(codexUsageView(resetFiles, 201)).toMatchObject({
      status: 'unavailable',
      line: 'Codex · awaiting new weekly reading',
      usedPercent: null,
    })
  })
})
