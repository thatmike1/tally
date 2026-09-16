// tests for the OpenAI api list-price table: matching, and the provenance that
// makes a dollar figure checkable.
import { describe, expect, it } from 'vitest'
import { OPENAI_PRICE_READ_AT, OPENAI_PRICE_SOURCE, OPENAI_PRICE_TABLE, openAiCost, openAiPrice } from './openai-prices'

describe('openAiPrice', () => {
  it('prices the ids Codex reports', () => {
    expect(openAiPrice('gpt-5.6-sol')).toEqual({ input: 4.0, cachedInput: 0.4, output: 20.0 })
    expect(openAiPrice('gpt-6-astra')).toEqual({ input: 10.0, cachedInput: 1.0, output: 50.0 })
    expect(openAiPrice('gpt-5.3-codex')).toEqual({ input: 1.75, cachedInput: 0.175, output: 14.0 })
  })

  it('matches a spaced or dated id by its base row', () => {
    expect(openAiPrice('GPT-5.6 Luna')).toEqual({ input: 0.2, cachedInput: 0.02, output: 1.2 })
    expect(openAiPrice('gpt-5.5-2026-08-01')?.output).toBe(30.0)
  })

  it('takes the longest matching prefix, so mini is not priced as its parent', () => {
    expect(openAiPrice('gpt-5.4-mini-2026-01-15')?.input).toBe(0.75)
    expect(openAiPrice('gpt-5.4')?.input).toBe(2.5)
  })

  it('returns null for an id with no row rather than guessing', () => {
    expect(openAiPrice('codex-auto-review')).toBeNull()
    expect(openAiPrice('gpt-7-nova')).toBeNull()
  })
})

describe('openAiCost', () => {
  it('charges cached input at its own rate and uncached input at the full one', () => {
    // input here already excludes the cached part, as `CodexCall` reports it
    expect(openAiCost('gpt-6-astra', 1_000_000, 2_000_000, 100_000)).toBeCloseTo(10 + 2 + 5)
  })

  it('has no cost for a model the table does not know', () => {
    expect(openAiCost('codex-auto-review', 1_000_000, 0, 0)).toBeNull()
  })
})

describe('the table itself', () => {
  it('records where and when it was read', () => {
    expect(OPENAI_PRICE_TABLE.source).toBe(OPENAI_PRICE_SOURCE)
    expect(OPENAI_PRICE_SOURCE).toMatch(/^https:\/\//)
    expect(OPENAI_PRICE_TABLE.readAt).toBe(OPENAI_PRICE_READ_AT)
    expect(OPENAI_PRICE_READ_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('has a positive input, cached and output rate on every row', () => {
    for (const [model, price] of Object.entries(OPENAI_PRICE_TABLE.models)) {
      expect(price.input, model).toBeGreaterThan(0)
      expect(price.cachedInput, model).toBeGreaterThan(0)
      expect(price.output, model).toBeGreaterThan(0)
      expect(price.cachedInput, model).toBeLessThan(price.input)
    }
  })
})
