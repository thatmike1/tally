// what a set of requests was made of: models, effort levels, token buckets and
// their list cost, and the same tokens at the price of the model each one
// replaced. a split row carries the first three, a split window all of them,
// and both come out of one accumulator, so a window's figures are always the
// sum of its rows.
import { costByBucket, costOf, predecessorOf, type Tokens } from './prices'
import type { Effort, RequestRecord } from './transcripts'

/** one model's part of a row or a window, as recorded on the request (`claude-opus-5-5`) */
export interface ModelUsage {
  model: string
  requests: number
  /** list price, usd */
  cost: number
}

/** how many requests ran at one effort level */
export interface EffortCount {
  /** null counts the requests whose transcript recorded no effort; never a default level */
  effort: Effort | null
  requests: number
}

/** one model's tokens priced again at the list price of the model it replaced */
export interface PredecessorCompare {
  /** the model the requests ran on, as recorded */
  model: string
  /** the model it replaced, a key of `PREDECESSOR` in `prices.ts` resolved to an id */
  predecessor: string
  requests: number
  /** the tokens both prices apply to */
  buckets: Tokens
  /** what they cost at `model`'s list price, usd */
  cost: number
  costByKind: Tokens
  /** what the same tokens cost at `predecessor`'s list price and its own cache multipliers, usd */
  predecessorCost: number
  predecessorCostByKind: Tokens
  /** cost / predecessorCost: 0.57 is 43% cheaper than the predecessor; null when that would cost nothing */
  ratio: number | null
}

/**
 * tokens and list cost over one window, covering exactly the requests its split
 * rows cover, so the rows add up to it.
 */
export interface SplitUsage {
  requests: number
  /** list price, usd; the same figure as the split's `totalCost` */
  cost: number
  /** tokens per bucket: `in` input, `cw5m` / `cw1h` cache writes, `cr` cache reads, `out` output */
  buckets: Tokens
  /** list cost per bucket, usd; the five add up to `cost` */
  costByKind: Tokens
  /** sorted by cost, most first */
  costByModel: ModelUsage[]
  /** one row per model in the window that has a predecessor, sorted by cost, most first */
  compare: PredecessorCompare[]
  /** at least one request had no price row, so `cost` is a floor */
  unpriced: boolean
}

/** what a split row gains from its requests */
export interface RowUsage {
  /** sorted by cost, most first */
  models: ModelUsage[]
  /** sorted by request count, most first; a `null` level last */
  effort: EffortCount[]
  buckets: Tokens
}

export function emptyTokens(): Tokens {
  return { in: 0, cw1h: 0, cw5m: 0, cr: 0, out: 0 }
}

function addTokens(into: Tokens, from: Tokens): void {
  into.in += from.in
  into.cw1h += from.cw1h
  into.cw5m += from.cw5m
  into.cr += from.cr
  into.out += from.out
}

/** the order effort levels sort in when two have the same count */
const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low']

function effortRank(effort: Effort | null): number {
  if (effort === null) return EFFORT_ORDER.length + 1
  const at = EFFORT_ORDER.indexOf(effort)
  return at === -1 ? EFFORT_ORDER.length : at
}

interface ModelTally {
  requests: number
  cost: number
  buckets: Tokens
}

/** requests in, row and window figures out */
export class UsageTally {
  private requests = 0
  private cost = 0
  private unpriced = false
  private readonly buckets = emptyTokens()
  private readonly byModel = new Map<string, ModelTally>()
  private readonly byEffort = new Map<Effort | null, number>()

  add(record: RequestRecord): void {
    this.requests++
    this.cost += record.cost
    if (!record.priced) this.unpriced = true
    const tokens: Tokens = { in: record.in, cw1h: record.cw1h, cw5m: record.cw5m, cr: record.cr, out: record.out }
    addTokens(this.buckets, tokens)
    let model = this.byModel.get(record.model)
    if (!model) {
      model = { requests: 0, cost: 0, buckets: emptyTokens() }
      this.byModel.set(record.model, model)
    }
    model.requests++
    model.cost += record.cost
    addTokens(model.buckets, tokens)
    this.byEffort.set(record.effort, (this.byEffort.get(record.effort) ?? 0) + 1)
  }

  models(): ModelUsage[] {
    return [...this.byModel.entries()]
      .map(([model, row]) => ({ model, requests: row.requests, cost: row.cost }))
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
  }

  effort(): EffortCount[] {
    return [...this.byEffort.entries()]
      .map(([effort, requests]) => ({ effort, requests }))
      .sort((a, b) => {
        if ((a.effort === null) !== (b.effort === null)) return a.effort === null ? 1 : -1
        return b.requests - a.requests || effortRank(a.effort) - effortRank(b.effort)
      })
  }

  row(): RowUsage {
    return { models: this.models(), effort: this.effort(), buckets: { ...this.buckets } }
  }

  /**
   * the window summary. costs per bucket are priced per model from the tokens,
   * so they sum to the stored per-request costs to float precision.
   */
  summary(): SplitUsage {
    const costByKind = emptyTokens()
    const compare: PredecessorCompare[] = []
    for (const [model, row] of this.byModel) {
      addTokens(costByKind, costByBucket(model, row.buckets))
      const predecessor = predecessorOf(model)
      if (predecessor === null) continue
      const predecessorCost = costOf(predecessor, row.buckets)
      compare.push({
        model,
        predecessor,
        requests: row.requests,
        buckets: { ...row.buckets },
        cost: row.cost,
        costByKind: costByBucket(model, row.buckets),
        predecessorCost,
        predecessorCostByKind: costByBucket(predecessor, row.buckets),
        ratio: predecessorCost > 0 ? row.cost / predecessorCost : null,
      })
    }
    compare.sort((a, b) => b.cost - a.cost)
    return {
      requests: this.requests,
      cost: this.cost,
      buckets: { ...this.buckets },
      costByKind,
      costByModel: this.models(),
      compare,
      unpriced: this.unpriced,
    }
  }
}

/** the summary of every request with `from <= t < to` */
export function splitUsage(records: RequestRecord[], from: number, to: number): SplitUsage {
  const tally = new UsageTally()
  for (const record of records) if (record.t >= from && record.t < to) tally.add(record)
  return tally.summary()
}
