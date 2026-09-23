// what a window was made of: the buckets, their cost, and the predecessor price.
import { describe, expect, it } from 'vitest'
import { costOf, familyOf, type Tokens } from './prices'
import { splitBlock } from './split'
import type { Effort, RequestRecord } from './transcripts'
import { splitUsage, UsageTally } from './usage'

function request(sessionId: string, t: number, model: string, tokens: Tokens, effort: Effort | null): RequestRecord {
  return {
    t,
    file: `/p/${sessionId}.jsonl`,
    mid: `msg-${sessionId}-${t}`,
    project: 'p',
    sessionId,
    agent: false,
    model,
    family: familyOf(model),
    priced: true,
    cost: costOf(model, tokens),
    effort,
    ...tokens,
  }
}

/** a cache-heavy opus 5.5 turn, the shape nearly every request has */
const TURN: Tokens = { in: 3, cw1h: 20_000, cw5m: 0, cr: 400_000, out: 1500 }

const records = [
  request('a', 10, 'claude-opus-5-5', TURN, 'xhigh'),
  request('a', 20, 'claude-opus-5-5', TURN, 'xhigh'),
  request('a', 30, 'claude-opus-5-5', TURN, 'high'),
  request('b', 40, 'claude-opus-5-5', TURN, null),
  request('b', 50, 'claude-sonnet-4-6', { in: 5, cw1h: 0, cw5m: 8000, cr: 100_000, out: 900 }, 'medium'),
  request('b', 60, 'claude-opus-5', TURN, 'high'),
]

describe('UsageTally', () => {
  it('prices each bucket so the kinds add up to the cost', () => {
    const usage = splitUsage(records, 0, 100)
    const kinds = usage.costByKind
    expect(kinds.in + kinds.cw1h + kinds.cw5m + kinds.cr + kinds.out).toBeCloseTo(usage.cost, 10)
    expect(usage.buckets.cr).toBe(4 * 400_000 + 100_000 + 400_000)
    expect(usage.requests).toBe(6)
    expect(usage.costByModel.map((m) => m.model)).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-4-6'])
    expect(usage.costByModel.reduce((sum, m) => sum + m.cost, 0)).toBeCloseTo(usage.cost, 10)
  })

  it('prices opus 5.5 tokens again at opus 5, with opus 5\'s own cache multipliers', () => {
    const usage = splitUsage(records, 0, 100)
    // only opus 5.5 has a predecessor; opus 5 and sonnet 4.6 do not
    expect(usage.compare.map((c) => [c.model, c.predecessor, c.requests])).toEqual([['claude-opus-5-5', 'claude-opus-5', 4]])
    const [compare] = usage.compare
    const four = { in: 4 * TURN.in, cw1h: 4 * TURN.cw1h, cw5m: 0, cr: 4 * TURN.cr, out: 4 * TURN.out }
    expect(compare!.buckets).toEqual(four)
    expect(compare!.cost).toBeCloseTo(costOf('claude-opus-5-5', four), 10)
    expect(compare!.predecessorCost).toBeCloseTo(costOf('claude-opus-5', four), 10)
    // the cache reads are where the gap is: 0.05x of $4 against 0.1x of $5
    expect(compare!.predecessorCostByKind.cr / compare!.costByKind.cr).toBeCloseTo(2.5, 10)
    expect(compare!.ratio).toBeCloseTo(compare!.cost / compare!.predecessorCost, 10)
    expect(compare!.ratio!).toBeLessThan(1)
  })

  it('counts effort levels, most first, with the unrecorded ones last and never defaulted', () => {
    const tally = new UsageTally()
    for (const record of records) tally.add(record)
    expect(tally.effort()).toEqual([
      // a tie goes to the higher level
      { effort: 'xhigh', requests: 2 },
      { effort: 'high', requests: 2 },
      { effort: 'medium', requests: 1 },
      { effort: null, requests: 1 },
    ])
  })

  it('is empty for an empty window', () => {
    const usage = new UsageTally().summary()
    expect(usage).toMatchObject({ requests: 0, cost: 0, costByModel: [], compare: [], unpriced: false })
  })
})

describe('split rows', () => {
  it('carry models, effort and buckets, and add up to the window usage', () => {
    const split = splitBlock(records, new Map(), { from: 0, to: 100, delta: 10 })
    const [a, b] = split.sessions.sort((x, y) => x.sessionId.localeCompare(y.sessionId))
    expect(a!.models).toEqual([{ model: 'claude-opus-5-5', requests: 3, cost: expect.closeTo(3 * costOf('claude-opus-5-5', TURN), 10) }])
    expect(a!.effort).toEqual([
      { effort: 'xhigh', requests: 2 },
      { effort: 'high', requests: 1 },
    ])
    expect(b!.models.map((m) => m.model).sort()).toEqual(['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-4-6'])
    const costs = b!.models.map((m) => m.cost)
    expect(costs).toEqual([...costs].sort((x, y) => y - x))
    expect(b!.effort.at(-1)).toEqual({ effort: null, requests: 1 })
    for (const key of ['in', 'cw1h', 'cw5m', 'cr', 'out'] as const) {
      expect(a!.buckets[key] + b!.buckets[key]).toBe(split.usage.buckets[key])
    }
    expect(split.usage.cost).toBeCloseTo(split.totalCost, 10)
  })

  it('leave requests outside the sampled span out of the usage, as out of the rows', () => {
    const split = splitBlock(records, new Map(), { from: 15, to: 45, delta: 10 })
    expect(split.usage.requests).toBe(3)
    expect(split.sessions.reduce((sum, row) => sum + row.requests, 0)).toBe(3)
  })
})
