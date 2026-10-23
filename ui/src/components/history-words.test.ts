// the sentences the history page writes about its blocks, days and weeks
import { describe, expect, it } from 'vitest'
import type { BlockSummary, WeekSummary, WindowUsage } from '../api'
import { blockLine, byDay, dayLead, familyPhrase, finishedWeeks, inWeek, longDay, planVerdict, pointRange, weekLead } from './history-words'

const HOUR = 3600
// Fri 16 Oct 2026 08:00 in Prague
const MORNING = Date.UTC(2026, 9, 16, 6) / 1000

function usage(cost: number, byFamily: WindowUsage['costByFamily'] = { opus: cost }, sessions = 2): WindowUsage {
  return {
    cost,
    costByFamily: byFamily,
    tokens: { in: 0, cw1h: 0, cw5m: 0, cr: 0, out: 0 },
    requests: 10,
    sessions,
    unpriced: false,
    cache: { readVsInput: null, writeVsRead: null },
  }
}

function block(start: number, extra: Partial<BlockSummary> = {}): BlockSummary {
  return {
    resetKey: start + 5 * HOUR,
    start,
    from: start,
    to: start + 4 * HOUR,
    startPct: 0,
    endPct: 40,
    delta: 40,
    saturated: false,
    maxGap: 300,
    measured: true,
    usage: usage(20),
    dollarsPerPercent: 0.5,
    ended: true,
    ...extra,
  }
}

function week(resetsAt: number, extra: Partial<WeekSummary> = {}): WeekSummary {
  return {
    resetsAt,
    start: resetsAt - 7 * 24 * HOUR,
    end: resetsAt,
    partial: false,
    from: resetsAt - 7 * 24 * HOUR,
    to: resetsAt,
    startPct: 0,
    endPct: 60,
    delta: 60,
    breakdown: null,
    chatsPercent: null,
    usage: usage(300),
    dollarsPerPercent: 5,
    fable: { model: 'claude-fable-5-1', startPct: 0, endPct: 30, delta: 30, cost: 90, dollarsPerPercent: 3 },
    ...extra,
  }
}

describe('familyPhrase', () => {
  it('says all of one family when it carried the block', () => {
    expect(familyPhrase(usage(10, { opus: 9.8, haiku: 0.2 }))).toBe('all Opus')
  })

  it('names each family with its cost, dearest first', () => {
    expect(familyPhrase(usage(30, { opus: 10, fable: 20 }))).toBe('Fable $20.00, Opus $10.00')
  })

  it('says nothing without a priced family', () => {
    expect(familyPhrase(usage(0, {}))).toBe('')
  })
})

describe('blockLine', () => {
  it('prices a measured block per point', () => {
    expect(blockLine(block(MORNING))).toEqual({ idle: false, text: '$20.00 over 2 sessions, all Opus', perPoint: 0.5 })
  })

  it('calls a block with no cost and no movement idle', () => {
    expect(blockLine(block(MORNING, { usage: usage(0, {}), delta: 0, measured: false, dollarsPerPercent: null })).idle).toBe(true)
  })

  it('says why a block has no price per point', () => {
    const unmeasured = { measured: false, dollarsPerPercent: null }
    expect(blockLine(block(MORNING, { ...unmeasured, saturated: true, endPct: 100 })).text).toBe(
      "Ran into 100%, so a point's price is not measured. $20.00 over 2 sessions, all Opus.",
    )
    expect(blockLine(block(MORNING, { ...unmeasured, maxGap: 45 * 60 })).text).toBe(
      '$20.00 over 2 sessions, all Opus. The sampler missed 45 minutes of it, so no price per point.',
    )
    expect(blockLine(block(MORNING, { ...unmeasured, delta: null })).text).toBe(
      '$20.00 over 2 sessions, all Opus. One meter reading only, so no price per point.',
    )
    expect(blockLine(block(MORNING, { ...unmeasured, delta: 0 })).text).toBe(
      '$20.00 over 2 sessions, all Opus. The meter did not move, so no price per point.',
    )
  })

  it('says one session, not one sessions', () => {
    expect(blockLine(block(MORNING, { usage: usage(3, { opus: 3 }, 1) })).text).toBe('$3.00 over 1 session, all Opus')
  })
})

describe('dayLead', () => {
  it('counts the blocks that ran and the ones that hit 100%', () => {
    const full = { endPct: 100, saturated: true, measured: false, dollarsPerPercent: null }
    expect(dayLead([block(MORNING)])).toBe('One block, short of 100%. $20.00 at list price.')
    expect(dayLead([block(MORNING), block(MORNING + 5 * HOUR, full)])).toBe('Two blocks, one ran to 100%. $40.00 at list price.')
    expect(dayLead([block(MORNING, full), block(MORNING + 5 * HOUR, full)])).toBe('Two blocks, both ran to 100%. $40.00 at list price.')
    expect(dayLead([block(MORNING), block(MORNING + 5 * HOUR)])).toBe('Two blocks, none ran to 100%. $40.00 at list price.')
    expect(dayLead([block(MORNING, full)])).toBe('One block, and it ran to 100%. $20.00 at list price.')
  })

  it('leaves idle blocks out of the count', () => {
    const idle = block(MORNING + 5 * HOUR, { usage: usage(0, {}), delta: 0 })
    expect(dayLead([block(MORNING), idle])).toBe('One block, short of 100%. $20.00 at list price.')
    expect(dayLead([idle])).toBe('Nothing ran.')
  })
})

describe('byDay', () => {
  it('groups blocks by the Prague day they started on, newest day first', () => {
    const late = block(MORNING + 15 * HOUR)
    const next = block(MORNING + 24 * HOUR)
    expect(byDay([block(MORNING), late, next]).map((day) => day.blocks.length)).toEqual([1, 2])
    expect(byDay([block(MORNING), late, next])[1]!.blocks[0]!.start).toBe(MORNING)
  })
})

describe('inWeek', () => {
  it('takes the blocks that started inside the window', () => {
    const w = week(MORNING + 24 * HOUR)
    expect(inWeek([block(w.start - HOUR), block(MORNING), block(w.resetsAt)], w).map((b) => b.start)).toEqual([MORNING])
  })
})

describe('pointRange', () => {
  it('reads the cheapest, dearest and middle measured point', () => {
    const blocks = [0.2, 0.9, 0.4].map((value, index) => block(MORNING + index * 5 * HOUR, { dollarsPerPercent: value }))
    blocks.push(block(MORNING + 20 * HOUR, { measured: false, dollarsPerPercent: null }))
    expect(pointRange(blocks)).toEqual({ min: 0.2, max: 0.9, middle: 0.4, count: 3 })
  })

  it('is null with nothing measured, never a zero', () => {
    expect(pointRange([block(MORNING, { measured: false, dollarsPerPercent: null })])).toBeNull()
  })
})

describe('weekLead', () => {
  it('says the week by its blocks, its ending and its cost', () => {
    const w = week(MORNING + 24 * HOUR)
    expect(weekLead(w, [block(MORNING), block(MORNING + 5 * HOUR, { usage: usage(0, {}), delta: 0 })])).toBe(
      'One block ran. The week ended at 60% weekly and 30% fable 5.1, on $300.',
    )
  })

  it('leaves Fable out when it was not read', () => {
    const w = week(MORNING + 24 * HOUR, { fable: { model: null, startPct: null, endPct: null, delta: null, cost: 0, dollarsPerPercent: null } })
    expect(weekLead(w, [block(MORNING), block(MORNING + 5 * HOUR)])).toBe('Two blocks ran. The week ended at 60% weekly, on $300.')
  })
})

describe('finishedWeeks', () => {
  it('names the last two finished weeks, newest first', () => {
    const weeks = [week(MORNING - 14 * 24 * HOUR, { endPct: 81 }), week(MORNING - 7 * 24 * HOUR, { endPct: 83 }), week(MORNING, { partial: true })]
    expect(finishedWeeks(weeks)).toBe('The last two finished weeks ended at 83% and 81%, with fable 5.1 at 30% and 30%.')
  })

  it('handles one and none', () => {
    expect(finishedWeeks([week(MORNING, { endPct: 12 })])).toBe('The one finished week ended at 12%, with fable 5.1 at 30%.')
    expect(finishedWeeks([week(MORNING, { partial: true })])).toBe('No week has finished since the first reading.')
  })
})

describe('planVerdict', () => {
  it('says the plan pays for itself once the month passes its price', () => {
    expect(planVerdict({ monthCost: 150, planUsd: 100 }).head).toBe('It pays for itself.')
  })

  it('says how far the month still has to go', () => {
    expect(planVerdict({ monthCost: 40, planUsd: 100 })).toEqual({ tone: '', head: 'Not yet the price.', rest: '$60.00 of list-price use to go this month.' })
  })
})

describe('longDay', () => {
  it('writes the day the way the letter does', () => {
    expect(longDay(MORNING)).toBe('friday 16 october')
  })
})
