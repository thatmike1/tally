// the list-price table, ported from cc-browse's `ccbrowse.py` (`PRICES`,
// `usage_cost`) and `projects/tally/jobs/extract.py`. list price is the divider
// the attribution proof settled on, so it has to agree with both to the cent.

/** usd per million tokens, as (input, output), keyed by model-id prefix */
export const PRICES: Record<string, readonly [number, number]> = {
  'claude-fable-5': [10.0, 50.0],
  'claude-mythos-5': [10.0, 50.0],
  'claude-opus-': [5.0, 25.0],
  'claude-sonnet-5': [3.0, 15.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-sonnet-4-5': [3.0, 15.0],
  'claude-haiku-4-5': [1.0, 5.0],
}

// multipliers on the base input price. a 1h cache write costs 2x and a 5m write
// 1.25x, so lumping the two would misprice whichever kind dominates.
export const CACHE_WRITE_1H_MULT = 2.0
export const CACHE_WRITE_5M_MULT = 1.25
export const CACHE_READ_MULT = 0.1

export const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku', 'other'] as const
export type Family = (typeof FAMILIES)[number]

export interface Tokens {
  in: number
  cw1h: number
  cw5m: number
  cr: number
  out: number
}

/** longest matching prefix wins, so `claude-sonnet-4-5` beats `claude-sonnet-` */
export function priceFor(model: string): readonly [number, number] | null {
  let best: readonly [number, number] | null = null
  let bestLen = -1
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price
      bestLen = prefix.length
    }
  }
  return best
}

export function familyOf(model: string): Family {
  for (const name of ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const) {
    if (model.includes(name)) return name
  }
  return 'other'
}

/** usd for one request's buckets; an unpriced model costs 0 and is flagged instead */
export function costOf(model: string, t: Tokens): number {
  const price = priceFor(model)
  if (!price) return 0
  const [base, out] = price
  return (
    (t.in * base +
      t.cw1h * base * CACHE_WRITE_1H_MULT +
      t.cw5m * base * CACHE_WRITE_5M_MULT +
      t.cr * base * CACHE_READ_MULT +
      t.out * out) /
    1e6
  )
}

export function totalTokens(t: Tokens): number {
  return t.in + t.cw1h + t.cw5m + t.cr + t.out
}
