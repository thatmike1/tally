// the assembled page state, over the frozen fixture home.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { limitsLogPath, readSamples } from './samples'
import { buildState } from './state'
import { TranscriptIndex } from './transcript-index'
import { projectsRoot, scan } from './transcripts'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
const NOW = 1789138000
/** the fixture's transcripts are all on 10 Sep 2026, so the day lanes are read from there */
const LANES_NOW = 1789062400

function tempLook(): string {
  return join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked')
}

async function stateAt(now: number, index?: TranscriptIndex) {
  return buildState({
    home: FIXTURE_HOME,
    now,
    index,
    // no T3 db and no index in a fixture home: both must degrade, not throw
    recordLook: false,
    lastLookedPath: tempLook(),
  })
}

async function state() {
  return buildState({
    home: FIXTURE_HOME,
    now: NOW,
    lastLookedPath: tempLook(),
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

  it('draws the day lanes off the transcripts, as activity and not as span', async () => {
    const built = await stateAt(LANES_NOW)
    expect(built.day.lanes.length).toBeGreaterThan(0)
    for (const lane of built.day.lanes) {
      expect(lane.kind).toBe('claude')
      expect(lane.segments.length).toBeGreaterThan(0)
      expect(lane.requests).toBeGreaterThan(0)
      // a lane never claims time outside the day it is drawn on
      expect(lane.start).toBeGreaterThanOrEqual(built.day.start)
      expect(lane.end).toBeLessThan(built.day.end)
      // segments are the requests, so they can only cover part of the span
      const covered = lane.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
      expect(covered).toBeLessThanOrEqual(lane.end - lane.start)
      expect(lane.segments.reduce((sum, s) => sum + s.requests, 0)).toBe(lane.requests)
    }
    // the fan-out shows up as a thicker part of the lane, not a row of its own
    expect(built.day.lanes.some((lane) => lane.agents > 0)).toBe(true)
    expect(built.day.lanes.some((lane) => lane.segments.some((s) => s.agents > 0))).toBe(true)
  })

  it('reports no index at all as cold and never building', async () => {
    const built = await state()
    expect(built.index).toEqual({ building: false, done: 0, total: 0, builtAt: null, cold: true, failed: 0 })
    expect(built.sources.index).toContain('transcripts.sqlite')
  })

  it('answers the same page out of a built index as off the tree', async () => {
    const index = new TranscriptIndex({ root: projectsRoot(FIXTURE_HOME), path: ':memory:' })
    const counts = await index.refresh()
    expect(counts.parsed).toBe(counts.seen)
    const indexed = await stateAt(LANES_NOW, index)
    const live = await stateAt(LANES_NOW)
    expect(indexed.day.lanes.length).toBeGreaterThan(0)
    expect(indexed.index.cold).toBe(false)
    expect(indexed.index.builtAt).not.toBeNull()
    expect(indexed.sources.index).toBe(':memory:')
    expect(indexed.day.lanes).toEqual(live.day.lanes)
    expect(indexed.split!.sessions).toEqual(live.split!.sessions)
    expect(indexed.week.weekly!.sessions).toEqual(live.week.weekly!.sessions)
    index.close()
  })

  it('finds no other-agent threads without a T3 db, rather than throwing', async () => {
    const built = await state()
    expect(built.others).toEqual([])
  })

  it('splits the weekly meters over the whole week when asked', async () => {
    const newest = readSamples(limitsLogPath(FIXTURE_HOME)).at(-1)!
    const built = await buildState({
      home: FIXTURE_HOME,
      now: NOW,
      recordLook: false,
      weekMode: 'whole',
      lastLookedPath: join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked'),
    })
    expect(built.week).toMatchObject({ since: 'week', from: newest.weeklyResetsAt! - 7 * 24 * 3600, to: NOW })
  })

  it('reports both weekly meters with a verdict each', async () => {
    const built = await state()
    expect(built.weekly!.verdict!.phrase.length).toBeGreaterThan(0)
    expect(built.fable!.model).toBe('Fable')
    expect(built.fable!.verdict!.phrase.length).toBeGreaterThan(0)
  })

  it('remembers the previous look and not this one', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tally-look-')), 'last-looked')
    const first = await buildState({ home: FIXTURE_HOME, now: NOW, lastLookedPath: path })
    expect(first.lastLooked).toBeNull()
    const second = await buildState({ home: FIXTURE_HOME, now: NOW + 600, lastLookedPath: path })
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
    const built = await buildState({ home: FIXTURE_HOME, now: NOW, lastLookedPath: path, recordLook: false })
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

  it('formats other limits as notes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-notes-home-'))
    const logDir = join(dir, '.cache', 'cc-browse-tray')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, 'limits.jsonl'),
      JSON.stringify({
        t: NOW,
        src: 'api',
        limits: { five_hour: { used_percentage: 20, resets_at: NOW + 18000 } },
        other_limits: [
          { kind: 'session', percent: 20, resets_at: '2026-09-14T22:20:00.000Z' },
          { kind: 'weekly_all', percent: 15 },
          { kind: 'boost', percent: 50, resets_at: '2026-09-14T22:20:00.000Z' },
          { custom: 'val' },
        ],
        unknown_key: 'something',
      }) + '\n',
    )
    const built = await buildState({
      home: dir,
      now: NOW,
      lastLookedPath: join(dir, 'last-looked'),
      recordLook: false,
    })
    expect(built.notes).toContain('sample carries an extra field: unknown_key')
    // session and weekly_all are the hero's own meters under their newer names
    expect(built.notes.some((note) => note.includes('session') || note.includes('weekly_all'))).toBe(false)
    expect(built.notes).toContain('limit: boost 50% resets Tue 00:20')
    expect(built.notes).toContain(JSON.stringify({ custom: 'val' }))
  })

  it('names its sources, so a wrong number can be traced home', async () => {
    const built = await state()
    expect(built.sources.limits).toContain('limits.jsonl')
    expect(built.sources.transcripts).toContain('.claude/projects')
  })
})

describe('buildState frozen at a past instant', () => {
  const samples = readSamples(limitsLogPath(FIXTURE_HOME))
  /** the middle reading of the fixture's last block: the meter climbs 63 -> 70 after it */
  const AT = samples.at(-2)!.t

  it('freezes the five-hour meter at the reading of that moment', async () => {
    const built = await buildState({ home: FIXTURE_HOME, at: AT, lastLookedPath: tempLook() })
    const frozen = samples.filter((s) => s.t <= AT).at(-1)!
    expect(built.now).toBe(AT)
    expect(built.fiveHour!.pct).toBe(frozen.pct)
    expect(built.fiveHour!.sampledAt).toBe(AT)
    expect(built.fiveHour!.ended).toBe(false)
    // the page really is frozen: the log's newest reading is a different number
    expect(frozen.pct).not.toBe(samples.at(-1)!.pct)
    expect(built.block!.resetsAt).toBe(frozen.resetKey)
    expect(built.block!.to).toBe(AT)
    expect(built.block!.samples.every((s) => s.t <= AT)).toBe(true)
    expect(built.day.meter.every((m) => m.t <= AT)).toBe(true)
    // a drill-in is not a look: no marker is read and none is written
    expect(built.lastLooked).toBeNull()
  })

  it('never picks a block that had not opened yet', async () => {
    // before the last block's first sample, the current block is the one before it
    const earlier = await buildState({ home: FIXTURE_HOME, at: samples.at(-3)!.t - 1, lastLookedPath: tempLook() })
    expect(earlier.block!.resetsAt).toBe(samples.at(-4)!.resetKey)
    expect(earlier.fiveHour!.sampledAt).toBe(samples.at(-4)!.t)
  })

  it('leaves the last-looked marker untouched', async () => {
    const path = tempLook()
    writeFileSync(path, '1789000000')
    const built = await buildState({ home: FIXTURE_HOME, at: AT, lastLookedPath: path })
    expect(built.lastLooked).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('1789000000')
  })
})
