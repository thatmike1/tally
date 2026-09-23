// OpenAI api list prices, the dollar answer to "what would this week have cost
// without the plan". this is NOT the Codex rate card in `codex-sessions.ts`:
// credits attribute the meter, these dollars price the same tokens at list.
// the two tables stay separate on purpose and never fall back to each other.
//
// read from the standard, short-context column of the published table; long
// context, batch, flex and fast mode are different rates and are not modelled.
// cache writes have their own published price, but a Codex rollout only reports
// input, cached input and output, so only those three are priced here.
import type { OpenAiPrice } from './history-types'

/** where the table below was read */
export const OPENAI_PRICE_SOURCE = 'https://platform.openai.com/docs/pricing'

/** the day the table was read, ISO; a stale table is a wrong dollar figure */
export const OPENAI_PRICE_READ_AT = '2026-09-23'

/**
 * usd per million tokens, keyed by the model id Codex reports. the three
 * gpt-6 rows, `gpt-5.6-sol`, `gpt-5.6-cyber` and `gpt-5.3-codex` come from the
 * pricing page itself (23 Sep), the rest from each model's page under
 * `/docs/models/<id>` (16 Sep).
 */
export const OPENAI_PRICES: Record<string, OpenAiPrice> = {
  'gpt-6-astra': { input: 10.0, cachedInput: 1.0, output: 50.0 },
  'gpt-6-sol': { input: 2.0, cachedInput: 0.2, output: 10.0 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4.0, cachedInput: 0.4, output: 20.0 },
  'gpt-5.6-terra': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.6-cyber': { input: 12.5, cachedInput: 1.25, output: 75.0 },
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10.0 },
}

/** the table as the endpoint publishes it, so the page can show where it came from */
export const OPENAI_PRICE_TABLE = {
  source: OPENAI_PRICE_SOURCE,
  readAt: OPENAI_PRICE_READ_AT,
  models: OPENAI_PRICES,
}

/**
 * the list price of one model id, or null when the table has no row for it.
 * matches like `codexRate`: case and spacing are normalised and a dated suffix
 * (`gpt-5.6-sol-2026-08`) falls back to its base row, longest prefix first so
 * `gpt-5.4-mini` never prices as `gpt-5.4`. an id with no row is never guessed.
 */
export function openAiPrice(model: string): OpenAiPrice | null {
  const key = model.toLowerCase().trim().replace(/\s+/g, '-')
  const exact = OPENAI_PRICES[key]
  if (exact) return exact
  const prefix = Object.keys(OPENAI_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((name) => key.startsWith(`${name}-`))
  return prefix ? OPENAI_PRICES[prefix]! : null
}

/**
 * usd for one call at list price, or null when the model has no row. `input`
 * excludes the cached part, exactly as `CodexCall` reports it.
 */
export function openAiCost(model: string, input: number, cached: number, output: number): number | null {
  const price = openAiPrice(model)
  if (!price) return null
  return (input * price.input + cached * price.cachedInput + output * price.output) / 1_000_000
}
