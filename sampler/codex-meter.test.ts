// the headless meter writes exactly the line the server's own reader writes,
// so the desktop reads a copied VPS log with the same parser
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexUsagePaths, readCodexHistory, recordCodexReading } from '../server/codex-usage'
import { sampleCodexMeter } from './codex-meter'

const reading = { sampledAt: 1_900_000_000.5, usedPercent: 37, resetsAt: 1_900_400_000, windowDurationMins: 10_080 }

describe('sampleCodexMeter', () => {
  it('appends one weekly reading in the reader log format', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-meter-'))
    const run = await sampleCodexMeter({ home, env: { CODEX_BIN: process.execPath }, now: reading.sampledAt, read: async () => reading })
    expect(run).toEqual({ ok: true, reading })
    const paths = codexUsagePaths(home)
    const reference = mkdtempSync(join(tmpdir(), 'tally-codex-reader-'))
    recordCodexReading(codexUsagePaths(reference), reading)
    expect(readFileSync(paths.history, 'utf8')).toBe(readFileSync(codexUsagePaths(reference).history, 'utf8'))
    expect(readCodexHistory(paths.history)).toEqual([reading])
    expect(JSON.parse(readFileSync(paths.status, 'utf8'))).toEqual({ checkedAt: reading.sampledAt, ok: true })
  })

  it('records a failed read as a failure, never as a reading', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-meter-'))
    const run = await sampleCodexMeter({ home, env: { CODEX_BIN: process.execPath }, now: 5, read: async () => { throw new Error('Codex usage request timed out') } })
    expect(run).toEqual({ ok: false, error: 'Codex usage request timed out' })
    expect(readCodexHistory(codexUsagePaths(home).history)).toEqual([])
    expect(JSON.parse(readFileSync(codexUsagePaths(home).status, 'utf8'))).toEqual({ checkedAt: 5, ok: false, error: 'Codex usage request timed out' })
  })

  it('says so when the box has no codex at all', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-meter-'))
    const run = await sampleCodexMeter({ home, env: { PATH: '' }, now: 5, read: async () => reading })
    expect(run.ok).toBe(false)
    expect(readCodexHistory(codexUsagePaths(home).history)).toEqual([])
  })
})
