// the assembled page state, over the frozen fixture home.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { limitsLogPath, readSamples } from './samples'
import { buildState } from './state'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
const NOW = 1789138000

async function state() {
  return buildState({
    home: FIXTURE_HOME,
    now: NOW,
    // no cc-browse and no T3 db in a fixture home; both must degrade, not throw
    ccbrowse: null,
    lastLookedPath: join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked'),
  })
}

describe('buildState', () => {
  it('headlines the newest api sample', async () => {
    const built = await state()
    const newest = readSamples(limitsLogPath(FIXTURE_HOME)).at(-1)!
    expect(built.fiveHour!.pct).toBe(newest.pct)
    expect(built.fiveHour!.resetsAt).toBe(newest.resetKey)
    expect(built.fiveHour!.ageSeconds).toBe(NOW - newest.t)
  })

  it('ranks the split by share', async () => {
    const built = await state()
    const shares = built.split!.sessions.map((s) => s.share)
    expect([...shares].sort((a, b) => b - a)).toEqual(shares)
    expect(built.split!.sessions.every((s) => s.kind === 'claude')).toBe(true)
  })

  it('gives the strip and the list the same colour per session', async () => {
    const built = await state()
    const colours = built.split!.sessions.map((s) => s.color)
    expect(colours.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
  })

  it('carries the caveat wherever points can appear', async () => {
    const built = await state()
    expect(built.caveat).toMatch(/list-price cost/)
    expect(built.caveat).toMatch(/quarter/)
  })

  it('says why the lanes are missing instead of dropping the section', async () => {
    const built = await state()
    expect(built.day.lanes).toEqual([])
    expect(built.day.lanesError).toMatch(/cc-browse/)
  })

  it('finds no other-agent threads without a T3 db, rather than throwing', async () => {
    const built = await state()
    expect(built.others).toEqual([])
  })

  it('reports both weekly meters with a verdict each', async () => {
    const built = await state()
    expect(built.weekly!.verdict!.phrase.length).toBeGreaterThan(0)
    expect(built.fable!.model).toBe('Fable')
    expect(built.fable!.verdict!.phrase.length).toBeGreaterThan(0)
  })

  it('remembers the previous look and not this one', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked')
    const first = await buildState({ home: FIXTURE_HOME, now: NOW, ccbrowse: null, lastLookedPath: path })
    expect(first.lastLooked).toBeNull()
    const second = await buildState({ home: FIXTURE_HOME, now: NOW + 600, ccbrowse: null, lastLookedPath: path })
    expect(second.lastLooked).toBe(NOW)
  })

  it('names its sources, so a wrong number can be traced home', async () => {
    const built = await state()
    expect(built.sources.limits).toContain('limits.jsonl')
    expect(built.sources.transcripts).toContain('.claude/projects')
  })
})
