// tests for reading models.json: the local file, url, last-good-copy order, a
// missing file that never throws, and the id rules that keep a new model from
// being priced as its neighbour.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadModelFacts, loadModelFactsSync, modelFactsSource, parseModelFacts, resolveModel, type ModelSources } from './models'
import { costOf, isPriced, priceFor } from './prices'

const FIXTURE = readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'models.json'), 'utf8')
const SMALL = JSON.stringify({
  schema: 1,
  generated: '2026-11-10T00:00:00+00:00',
  aliases: { opus: 'claude-opus-5-5' },
  models: {
    'claude-opus-5-5': {
      name: 'Claude Opus 5.5', label: 'Opus 5.5', short: 'Opus', family: 'opus', vendor: 'Anthropic', status: 'current', aliases: ['opus'],
      prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, tiers: [], source: 'litellm' }, codexCredits: null,
    },
  },
})

function sources(over: Partial<ModelSources> = {}): ModelSources {
  const dir = mkdtempSync(join(tmpdir(), 'tally-models-'))
  return { local: join(dir, 'absent.json'), url: null, cache: join(dir, 'cache', 'models.json'), ...over }
}

afterEach(() => {
  // put the suite's own facts back for the other tests in this file
  loadModelFactsSync()
})

describe('loading models.json', () => {
  it('reads the local file first and keeps a copy', async () => {
    const s = sources()
    writeFileSync(s.local!, SMALL)
    expect(await loadModelFacts(s)).toBe('local')
    expect(parseModelFacts(readFileSync(s.cache, 'utf8'))?.models['claude-opus-5-5']).toBeDefined()
  })

  it('falls back to the url, then to the last good copy', async () => {
    const server = createServer((_req, res) => res.end(SMALL))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/models.json`
    const s = sources({ url })
    try {
      expect(await loadModelFacts(s)).toBe('url')
    } finally {
      server.close()
    }
    expect(await loadModelFacts({ ...s, url: 'http://127.0.0.1:9/models.json' }, 500)).toBe('cache')
    expect(priceFor('claude-opus-5-5')).toEqual([4, 20])
  })

  it('runs with nothing at all: every model unpriced, nothing thrown', async () => {
    const s = sources()
    writeFileSync(s.local!, '{ not json')
    expect(await loadModelFacts(s)).toBe('none')
    expect(modelFactsSource()).toBe('none')
    expect(isPriced('claude-opus-5-5')).toBe(false)
    expect(costOf('claude-opus-5-5', { in: 1e6, cw1h: 0, cw5m: 0, cr: 0, out: 0 })).toBe(0)
    expect(isPriced('<synthetic>')).toBe(true)
  })

  it('rejects a file that is not models.json', () => {
    expect(parseModelFacts('{"schema": 2, "models": {}}')).toBeNull()
    expect(parseModelFacts(FIXTURE)?.models['claude-fable-5-2']?.prices?.input).toBe(8)
  })
})

describe('resolveModel', () => {
  it('resolves aliases, context suffixes and dated ids', () => {
    expect(resolveModel('fable')).toBe('claude-fable-5-2')
    expect(resolveModel('claude-fable-5-1[1m]')).toBe('claude-fable-5-1')
    expect(resolveModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(resolveModel('GPT-6.1 Sol')).toBe('gpt-6.1-sol')
  })

  it('never prices a newer version as the one before it', () => {
    expect(resolveModel('claude-fable-5-3')).toBeNull()
    expect(resolveModel('claude-opus-5-6')).toBeNull()
    expect(isPriced('claude-fable-5-3')).toBe(false)
    expect(resolveModel('gpt-5.4-nano')).toBeNull()
  })
})
