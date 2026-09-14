// the assembled page state, over the frozen fixture home.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { limitsLogPath, readSamples } from './samples'
import { buildState } from './state'
import { projectsRoot, scan } from './transcripts'

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

  it('splits the weekly meters since midnight when there is no last look', async () => {
    const built = await state()
    expect(built.week.since).toBe('today')
    expect(built.week.weekly!.from).toBeGreaterThanOrEqual(built.week.from)
    expect(built.week.weekly!.to).toBeLessThanOrEqual(NOW)
  })

  it('gives the Fable meter only to sessions with Fable requests, since the last look', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked')
    // 10 Sep 2026 02:26 Prague, inside the fixture's weekly period
    writeFileSync(path, '1789000000')
    const built = await buildState({ home: FIXTURE_HOME, now: NOW, ccbrowse: null, lastLookedPath: path, recordLook: false })
    const { fable, weekly } = built.week
    expect(built.week.since).toBe('lastLooked')
    expect(fable!.delta).toBeGreaterThan(0)
    expect(fable!.sessions.length).toBeGreaterThan(0)
    expect(weekly!.sessions.length).toBeGreaterThan(fable!.sessions.length)
    const { records } = await scan(fable!.from, fable!.to, projectsRoot(FIXTURE_HOME))
    const withFable = new Set(records.filter((r) => r.family === 'fable').map((r) => r.sessionId))
    expect(fable!.sessions.every((row) => withFable.has(row.sessionId))).toBe(true)
    for (const row of weekly!.sessions) {
      expect(row.fableShare).toBe(withFable.has(row.sessionId) ? fable!.sessions.find((f) => f.sessionId === row.sessionId)!.share : 0)
      // one colour per session across both week strips
      const inFable = fable!.sessions.find((f) => f.sessionId === row.sessionId)
      if (inFable) expect(inFable.color).toBe(row.color)
    }
  })

  it('names its sources, so a wrong number can be traced home', async () => {
    const built = await state()
    expect(built.sources.limits).toContain('limits.jsonl')
    expect(built.sources.transcripts).toContain('.claude/projects')
  })
})
