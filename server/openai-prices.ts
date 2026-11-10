// OpenAI api list prices, the dollar answer to "what would this week have cost
// without the plan". this is NOT the Codex rate card in `codex-sessions.ts`:
// credits attribute the meter, these dollars price the same tokens at list.
// the two stay separate on purpose and never fall back to each other.
//
// both come from the model map's `models.json` (`models.ts`): list prices from
// litellm's table, the standard short-context column; long context, batch and
// flex are different rates and are not modelled. fast mode is 2x standard for the
// supported Codex models, read 9 Oct 2026 (`codex-speed.ts`). cache writes have
// their own published price, but a Codex rollout only reports input, cached input
// and output, so only those three are priced here.
import type { OpenAiPrice } from './history-types'
import { speedMultiplier, type CodexSpeed } from './codex-speed'
import { modelFact, modelFacts } from './models'

/** where the prices were read, and the day; a stale table is a wrong dollar figure */
export function openAiPriceTable(): { source: string; readAt: string; models: Record<string, OpenAiPrice> } {
  const facts = modelFacts()
  const models: Record<string, OpenAiPrice> = {}
  for (const [id, fact] of Object.entries(facts.models)) {
    const price = fact.vendor === 'OpenAI' ? toOpenAi(fact.prices) : null
    if (price) models[id] = price
  }
  return {
    source: facts.sources?.prices?.url ?? 'https://models.thatmike1.dev/models.json',
    readAt: (facts.sources?.prices?.fetched ?? facts.generated ?? '').slice(0, 10),
    models,
  }
}

function toOpenAi(prices: { input: number; output: number; cacheRead?: number } | null): OpenAiPrice | null {
  if (!prices || prices.cacheRead === undefined) return null
  return { input: prices.input, cachedInput: prices.cacheRead, output: prices.output }
}

/**
 * the list price of one model id, or null when models.json has no row for it.
 * matches like `codexRate`: case and spacing are normalised and a dated suffix
 * (`gpt-5.6-sol-2026-08`) falls back to its base row; `gpt-5.4-nano` is never
 * priced as `gpt-5.4`. an id with no row is never guessed.
 */
export function openAiPrice(model: string): OpenAiPrice | null {
  const fact = modelFact(model)
  return fact && fact.vendor === 'OpenAI' ? toOpenAi(fact.prices) : null
}

/**
 * usd for one call at list price, or null when the model has no row. `input`
 * excludes the cached part, exactly as `CodexCall` reports it.
 */
export function openAiCost(model: string, input: number, cached: number, output: number, speed: CodexSpeed | null = 'standard'): number | null {
  const price = openAiPrice(model)
  if (!price) return null
  return (input * price.input + cached * price.cachedInput + output * price.output) * speedMultiplier(speed) / 1_000_000
}
