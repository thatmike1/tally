// claude list prices, read from the model map's `models.json` (`models.ts`) instead of
// a table kept here: litellm's published prices, filled from hand-verified values only
// where litellm lacks one. list price is the divider the attribution proof settled on;
// standard claude speed only. a model the file does not know is unpriced and flagged,
// never priced as its neighbour, so a new model with no row shows up as a floor.
import { modelFact, modelFacts, type PriceFields, type PriceTier } from './models'

/**
 * ids that cost nothing by definition. claude code writes `<synthetic>` for its
 * own zero-token messages (interrupts, api errors), so a session holding one is
 * not missing a price.
 */
export const FREE_MODELS: readonly string[] = ['<synthetic>']

// anthropic's published multipliers on the base input price, used only for a model
// whose own cache price is missing from the file
const CACHE_WRITE_1H_MULT = 2.0
const CACHE_WRITE_5M_MULT = 1.25
const CACHE_READ_MULT = 0.1

interface ClaudePrice extends PriceFields {
  tiers: PriceTier[]
}

/** the anthropic price row for a model id, or null when the file has none */
function claudePrice(model: string): ClaudePrice | null {
  const fact = modelFact(model)
  return fact && fact.vendor === 'Anthropic' && fact.prices ? fact.prices : null
}

/** changes whenever a price does, so the transcript index knows to reprice its stored costs */
export function priceTableKey(): string {
  const rows = Object.entries(modelFacts().models)
    .filter(([, fact]) => fact.vendor === 'Anthropic')
    .map(([id, fact]) => [id, fact.prices && { ...fact.prices, source: undefined }, fact.replaces ?? null])
  return JSON.stringify([rows, modelFacts().aliases, FREE_MODELS])
}

/** usd per million tokens, as (input, output) */
export function priceFor(model: string): readonly [number, number] | null {
  const price = claudePrice(model)
  return price ? [price.input, price.output] : null
}

/** false only for a model whose cost we cannot know, which makes any total it is in a floor */
export function isPriced(model: string): boolean {
  return FREE_MODELS.includes(model) || priceFor(model) !== null
}

export const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku', 'other'] as const
export type Family = (typeof FAMILIES)[number]

export interface Tokens {
  in: number
  cw1h: number
  cw5m: number
  cr: number
  out: number
}

export function familyOf(model: string): Family {
  for (const name of ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const) {
    if (model.includes(name)) return name
  }
  return 'other'
}

/**
 * the model `model` replaced (`replaces` in models.json), so a window can say what
 * its tokens would have cost on the older one, priced with that model's own cache
 * prices: `claude-opus-5` reads its cache at 0.1x where opus 5.5 reads at 0.05x,
 * and that difference is most of what the comparison shows. null when it has none.
 */
export function predecessorOf(model: string): string | null {
  return modelFact(model)?.replaces ?? null
}

/**
 * usd per token bucket for one request: the parts `costOf` adds up. a long-prompt
 * tier (haiku 5.5 past 100k) applies when the whole prompt, cache included, is
 * over its threshold; output never counts toward it. an unpriced model is all zeros.
 */
export function costByBucket(model: string, t: Tokens): Tokens {
  const row = claudePrice(model)
  if (!row) return { in: 0, cw1h: 0, cw5m: 0, cr: 0, out: 0 }
  const prompt = t.in + t.cw1h + t.cw5m + t.cr
  const tier = row.tiers.filter((x) => prompt > x.aboveInputTokens).sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)[0]
  const p: PriceFields = tier ? { ...row, ...tier } : row
  return {
    in: (t.in * p.input) / 1e6,
    cw1h: (t.cw1h * (p.cacheWrite1h ?? p.input * CACHE_WRITE_1H_MULT)) / 1e6,
    cw5m: (t.cw5m * (p.cacheWrite5m ?? p.input * CACHE_WRITE_5M_MULT)) / 1e6,
    cr: (t.cr * (p.cacheRead ?? p.input * CACHE_READ_MULT)) / 1e6,
    out: (t.out * p.output) / 1e6,
  }
}

/** usd for one request's buckets; an unpriced model costs 0 and is flagged instead */
export function costOf(model: string, t: Tokens): number {
  return totalTokens(costByBucket(model, t))
}

export function totalTokens(t: Tokens): number {
  return t.in + t.cw1h + t.cw5m + t.cr + t.out
}
