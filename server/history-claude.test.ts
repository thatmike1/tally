// the history table, against the same python oracle the block table uses.
//
// `test/fixtures/survey-expected.txt` is `jobs/survey.py`'s own stdout over
// `test/fixtures/home`; every block here has to report the same measured points,
// tokens and list cost, because those three are what the whole page divides.
// the parser below is `blocks.test.ts`'s, copied rather than imported: importing
// a test module would register its suites a second time.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeHistory } from './history-claude'
import { MEASURED_MAX_GAP } from './history-types'
import { limitsLogPath, readSamples } from './samples'
import { WEEK } from './split'
import { startOfMonth } from './time'
import { projectsRoot, scan } from './transcripts'

const FIXTURE_HOME = join(import.meta.dirname, '..', 'test', 'fixtures', 'home')
const SURVEY = join(import.meta.dirname, '..', 'test', 'fixtures', 'survey-expected.txt')
/** the same instant `state.test.ts` freezes the fixture at */
const NOW = 1789138000
/** the fixture's one weekly window: reset 12 Sep 2026 21:00 UTC, still open at NOW */
const WEEK_RESET = 1789246800
const SATURATED_BLOCK = 1789057200

interface OracleRow {
  label: string
  points: number
  mtok: number
  cost: number
}

function oracleRows(): OracleRow[] {
  const out: OracleRow[] = []
  for (const line of readFileSync(SURVEY, 'utf8').split('\n')) {
    const match = /^(\d\d \w\w\w \d\d:\d\d)\s+(-?\d+)\s+(\d+\.\d)\s+(\d+\.\d)\s/.exec(line)
    if (match) out.push({ label: match[1]!, points: Number(match[2]), mtok: Number(match[3]), cost: Number(match[4]) })
  }
  return out
}

const label = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Prague',
  day: '2-digit',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function blockLabel(start: number): string {
  const parts = label.formatToParts(new Date(start * 1000))
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('day')} ${MONTHS[Number(get('month')) - 1]} ${get('hour')}:${get('minute')}`
}

/** a home of its own with the fixture's transcripts and limits, so a test can add a raw usage log */
function homeLike(fixtureLimits: boolean, limits?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'tally-history-'))
  mkdirSync(join(home, '.cache', 'cc-browse-tray'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  symlinkSync(projectsRoot(FIXTURE_HOME), join(home, '.claude', 'projects'))
  writeFileSync(
    limitsLogPath(home),
    fixtureLimits ? readFileSync(limitsLogPath(FIXTURE_HOME), 'utf8') : (limits ?? ''),
  )
  return home
}

function breakdownRow(t: number, windowStart: number, chat: number): string {
  return JSON.stringify({
    t,
    payload: {
      seven_day_breakdown: {
        as_of: new Date(t * 1000).toISOString(),
        window_started_at: new Date(windowStart * 1000).toISOString(),
        rows: [
          { key: 'claude_code', display_name: 'Claude Code', percent: 100 - chat },
          { key: 'chat', display_name: 'Chats', percent: chat },
        ],
      },
    },
  })
}

async function history(home = FIXTURE_HOME) {
  return claudeHistory({ home, now: NOW })
}

describe('the history blocks, against jobs/survey.py', () => {
  it('reports the same points, tokens and list cost per block', async () => {
    const expected = oracleRows()
    const { blocks } = await history()
    expect(blocks).toHaveLength(expected.length)

    blocks.forEach((block, index) => {
      const row = expected[index]!
      const tokens = block.usage.tokens
      const total = tokens.in + tokens.cw1h + tokens.cw5m + tokens.cr + tokens.out
      expect(blockLabel(block.start), `block ${index}`).toBe(row.label)
      expect(block.delta, `${row.label} points`).toBe(row.points)
      // survey.py prints one decimal, so agreement is to half of one
      expect(total / 1e6, `${row.label} Mtok`).toBeCloseTo(row.mtok, 1)
      expect(block.usage.cost, `${row.label} list cost`).toBeCloseTo(row.cost, 1)
    })
  })

  it('divides cost by the delta only where the block was measured', async () => {
    const { blocks } = await history()
    for (const block of blocks) {
      if (block.measured) {
        expect(block.delta).toBeGreaterThan(0)
        expect(block.saturated).toBe(false)
        expect(block.maxGap).toBeLessThanOrEqual(MEASURED_MAX_GAP)
        expect(block.dollarsPerPercent).toBeCloseTo(block.usage.cost / block.delta!, 9)
      } else {
        expect(block.dollarsPerPercent).toBeNull()
      }
    }
  })

  it('never measures a saturated block: movement above 100% is censored', async () => {
    const { blocks } = await history()
    const saturated = blocks.find((b) => b.resetKey === SATURATED_BLOCK)!
    expect(saturated.saturated).toBe(true)
    expect(saturated.endPct).toBe(100)
    expect(saturated.measured).toBe(false)
    expect(saturated.dollarsPerPercent).toBeNull()
  })

  it('never measures a block read once: there is no delta to divide', async () => {
    const home = homeLike(
      false,
      JSON.stringify({
        t: 1789100000,
        src: 'api',
        limits: {
          five_hour: { used_percentage: 34, resets_at: 1789110000 },
          seven_day: { used_percentage: 60, resets_at: WEEK_RESET },
        },
      }) + '\n',
    )
    const { blocks, weeks } = await claudeHistory({ home, now: NOW })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.delta).toBeNull()
    expect(blocks[0]!.measured).toBe(false)
    expect(blocks[0]!.dollarsPerPercent).toBeNull()
    // and a weekly window read once has no figure either, breakdown or not
    expect(weeks[0]!.delta).toBeNull()
    expect(weeks[0]!.dollarsPerPercent).toBeNull()
    expect(weeks[0]!.breakdown).toBeNull()
  })
})

describe('the weekly windows', () => {
  it('subtracts the Chats share before dividing cost into the movement', async () => {
    const home = homeLike(true)
    const windowStart = WEEK_RESET - WEEK
    writeFileSync(
      join(home, '.cache', 'cc-browse-tray', 'usage-raw.jsonl'),
      [
        // an older sample of the same window, and one for the window before it
        breakdownRow(windowStart - 3600, windowStart - WEEK, 55),
        breakdownRow(windowStart + 3600, windowStart, 90),
        breakdownRow(NOW - 600, windowStart, 20),
      ].join('\n') + '\n',
    )

    const { weeks } = await claudeHistory({ home, now: NOW })
    expect(weeks).toHaveLength(1)
    const week = weeks[0]!
    expect(week.partial).toBe(true)
    expect(week.chatsPercent).toBe(20)
    expect(week.breakdown!.at).toBe(NOW - 600)

    // the same figures again, from the fixture rather than from the answer
    const samples = readSamples(limitsLogPath(FIXTURE_HOME)).filter((s) => s.weeklyPct !== null)
    const first = samples[0]!
    const last = samples.at(-1)!
    const delta = last.weeklyPct! - first.weeklyPct!
    const { records } = await scan(first.t, last.t, projectsRoot(FIXTURE_HOME))
    const cost = records.reduce((sum, r) => sum + r.cost, 0)
    expect(week.from).toBe(first.t)
    expect(week.to).toBe(last.t)
    expect(week.delta).toBe(delta)
    expect(week.usage.cost).toBeCloseTo(cost, 9)
    expect(week.dollarsPerPercent).toBeCloseTo(cost / (delta * 0.8), 9)
  })

  it('has no weekly figure at all without a breakdown', async () => {
    const { weeks } = await history()
    expect(weeks[0]!.breakdown).toBeNull()
    expect(weeks[0]!.chatsPercent).toBeNull()
    expect(weeks[0]!.dollarsPerPercent).toBeNull()
    // the Fable meter needs no breakdown: Chats do not move it
    expect(weeks[0]!.fable.model).toBe('Fable')
    expect(weeks[0]!.fable.delta).toBeGreaterThan(0)
    expect(weeks[0]!.fable.dollarsPerPercent).toBeCloseTo(weeks[0]!.fable.cost / weeks[0]!.fable.delta!, 9)
  })
})

describe('the sub value', () => {
  it('totals the month to date from the first of the month in Prague', async () => {
    const built = await history()
    const monthStart = startOfMonth(NOW)
    expect(built.subValue.monthStart).toBe(monthStart)
    expect(built.subValue.planUsd).toBe(100)

    const { records } = await scan(monthStart, NOW, projectsRoot(FIXTURE_HOME))
    const cost = records.reduce((sum, r) => sum + r.cost, 0)
    expect(built.subValue.monthCost).toBeCloseTo(cost, 9)
    expect(cost).toBeGreaterThan(0)
  })

  it('totals the week from the weekly window that is open now', async () => {
    const built = await history()
    expect(built.subValue.weekStart).toBe(WEEK_RESET - WEEK)
    const { records } = await scan(built.subValue.weekStart, NOW, projectsRoot(FIXTURE_HOME))
    expect(built.subValue.weekCost).toBeCloseTo(
      records.reduce((sum, r) => sum + r.cost, 0),
      9,
    )
  })
})

describe('the envelope', () => {
  it('names its sources and says nothing is indexed', async () => {
    const built = await history()
    expect(built.now).toBe(NOW)
    expect(built.since).toBe(1788825600)
    expect(built.indexing).toBe(false)
    expect(built.sources.limits).toBe(limitsLogPath(FIXTURE_HOME))
    expect(built.caveat).toMatch(/Chats/)
  })
})
