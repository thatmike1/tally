// the list-price table, first ported from cc-browse's `ccbrowse.py` (`PRICES`,
// `usage_cost`). list price is the divider the attribution proof settled on.
// read from https://platform.claude.com/docs/en/about-claude/pricing on 23 Sep
// 2026; standard speed only, fast mode is not modelled.

/** usd per million tokens, as (input, output), keyed by model-id prefix */
export const PRICES: Record<string, readonly [number, number]> = {
  'claude-fable-5-1': [10.0, 50.0],
  'claude-fable-5': [10.0, 50.0],
  'claude-mythos-5-1': [10.0, 50.0],
  'claude-mythos-5': [10.0, 50.0],
  'claude-opus-5-5': [4.0, 20.0],
  'claude-opus-': [5.0, 25.0],
  'claude-sonnet-5': [2.0, 10.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-sonnet-4-5': [3.0, 15.0],
  'claude-haiku-4-5': [1.0, 5.0],
}

// multipliers on the base input price. a 1h cache write costs 2x and a 5m write
// 1.25x, so lumping the two would misprice whichever kind dominates.
export const CACHE_WRITE_1H_MULT = 2.0
export const CACHE_WRITE_5M_MULT = 1.25
export const CACHE_READ_MULT = 0.1

/** models whose cache reads break the 0.1x rule, keyed by the same prefixes as `PRICES` */
export const CACHE_READ_MULT_BY_PREFIX: Record<string, number> = {
  'claude-fable-5-1': 0.025,
  'claude-mythos-5-1': 0.025,
  'claude-opus-5-5': 0.05,
}

/**
 * ids that cost nothing by definition. claude code writes `<synthetic>` for its
 * own zero-token messages (interrupts, api errors), so a session holding one is
 * not missing a price.
 */
export const FREE_MODELS: readonly string[] = ['<synthetic>']

/** changes whenever a price does, so the transcript index knows to reprice its stored costs */
export const PRICE_TABLE_KEY = JSON.stringify([PRICES, CACHE_READ_MULT_BY_PREFIX, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT, CACHE_READ_MULT, FREE_MODELS])

export const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku', 'other'] as const
export type Family = (typeof FAMILIES)[number]

export interface Tokens {
  in: number
  cw1h: number
  cw5m: number
  cr: number
  out: number
}

/** longest matching prefix wins, so `claude-opus-5-5` beats `claude-opus-` */
function pricePrefix(model: string): string | null {
  let best: string | null = null
  for (const prefix of Object.keys(PRICES)) {
    if (model.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix
  }
  return best
}

export function priceFor(model: string): readonly [number, number] | null {
  const prefix = pricePrefix(model)
  return prefix ? PRICES[prefix]! : null
}

/** false only for a model whose cost we cannot know, which makes any total it is in a floor */
export function isPriced(model: string): boolean {
  return FREE_MODELS.includes(model) || priceFor(model) !== null
}

/** the cache-read multiplier on base input, 0.1x unless the model has its own */
export function cacheReadMult(model: string): number {
  const prefix = pricePrefix(model)
  return (prefix === null ? undefined : CACHE_READ_MULT_BY_PREFIX[prefix]) ?? CACHE_READ_MULT
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
      t.cr * base * cacheReadMult(model) +
      t.out * out) /
    1e6
  )
}

export function totalTokens(t: Tokens): number {
  return t.in + t.cw1h + t.cw5m + t.cr + t.out
}
