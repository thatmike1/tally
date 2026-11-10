// model facts: names, aliases, list prices and codex credit rates, read from the
// model map's `models.json` instead of tables kept here. the file is generated in
// ccChat-general (`claude/model-map/models_json.py`) and published at
// https://models.thatmike1.dev/models.json.
//
// where it is read, first hit wins:
//   1. a local file: `$TALLY_MODELS`, else `modelsPath` in the config, else the
//      ccChat-general checkout at `~/git/ccChat-general/claude/model-map/models.json`
//   2. the url: `$TALLY_MODELS_URL`, else `modelsUrl` in the config, else the public one
//   3. the last good copy, `~/.cache/tally/models.json` (`$TALLY_MODELS_CACHE`),
//      written whenever 1 or 2 works
// none of them is required: with nothing, every model is unpriced and the page says
// so, the same as for a model the file does not know.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { tallyConfig } from './config'

export const MODELS_URL = 'https://models.thatmike1.dev/models.json'

/** usd per 1M tokens; a field the vendor does not publish is absent */
export interface PriceFields {
  input: number
  output: number
  cacheRead?: number
  cacheWrite5m?: number
  cacheWrite1h?: number
}

/** a long-prompt bracket: its fields replace the base ones once the prompt passes `aboveInputTokens` */
export type PriceTier = Partial<PriceFields> & { aboveInputTokens: number }

export interface ModelPrices extends PriceFields {
  tiers: PriceTier[]
  source: string
}

export interface ModelFact {
  name: string
  label: string
  short: string
  family: string
  vendor: string
  status: 'current' | 'superseded'
  aliases: string[]
  replaces?: string | null
  prices: ModelPrices | null
  /** codex credits per 1M tokens */
  codexCredits: { input: number; cached: number; output: number } | null
}

export interface ModelFacts {
  schema: number
  generated: string
  sources?: { prices?: { url?: string; fetched?: string | null } }
  aliases: Record<string, string>
  models: Record<string, ModelFact>
}

export interface ModelSources {
  local: string | null
  url: string | null
  cache: string
}

const EMPTY: ModelFacts = { schema: 1, generated: '', aliases: {}, models: {} }

let installed: ModelFacts | null = null
let installedFrom = 'none'
let localMtime: number | null = null
let lastUrlTry = 0

function text(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** where this machine looks, from the environment and the config file */
export function modelSources(env: NodeJS.ProcessEnv = process.env, home = homedir()): ModelSources {
  const config = tallyConfig()
  const url = env.TALLY_MODELS_URL !== undefined ? text(env.TALLY_MODELS_URL) : (config.modelsUrl ?? MODELS_URL)
  return {
    local: text(env.TALLY_MODELS) ?? config.modelsPath ?? join(home, 'git', 'ccChat-general', 'claude', 'model-map', 'models.json'),
    url,
    cache: text(env.TALLY_MODELS_CACHE) ?? join(home, '.cache', 'tally', 'models.json'),
  }
}

/** the parsed file, or null when it is not a models.json tally can read */
export function parseModelFacts(raw: string): ModelFacts | null {
  try {
    const data = JSON.parse(raw) as Partial<ModelFacts>
    if (data.schema !== 1 || typeof data.models !== 'object' || data.models === null) return null
    return { ...EMPTY, ...data, aliases: data.aliases ?? {}, models: data.models } as ModelFacts
  } catch {
    return null
  }
}

function readFacts(path: string | null): ModelFacts | null {
  if (!path) return null
  try {
    return parseModelFacts(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function mtimeOf(path: string | null): number | null {
  try {
    return path ? statSync(path).mtimeMs : null
  } catch {
    return null
  }
}

function keepCopy(facts: ModelFacts, cache: string): void {
  try {
    mkdirSync(dirname(cache), { recursive: true })
    const tmp = `${cache}.tmp`
    writeFileSync(tmp, JSON.stringify(facts))
    renameSync(tmp, cache)
  } catch {
    // a cache that cannot be written only costs the next offline start its prices
  }
}

export function installModelFacts(facts: ModelFacts, from = 'injected'): void {
  installed = facts
  installedFrom = from
}

/** where the facts in use came from: `local`, `url`, `cache`, `none` or `injected` */
export function modelFactsSource(): string {
  return installedFrom
}

/** local file, then the last good copy; never the network, so it can run at import time */
export function loadModelFactsSync(sources: ModelSources = modelSources()): ModelFacts {
  const local = readFacts(sources.local)
  if (local) {
    localMtime = mtimeOf(sources.local)
    keepCopy(local, sources.cache)
    installModelFacts(local, 'local')
    return local
  }
  const cached = readFacts(sources.cache)
  installModelFacts(cached ?? EMPTY, cached ? 'cache' : 'none')
  return installed!
}

/** local file, then the url, then the last good copy; never throws */
export async function loadModelFacts(sources: ModelSources = modelSources(), timeoutMs = 5000): Promise<string> {
  const local = readFacts(sources.local)
  if (local) {
    localMtime = mtimeOf(sources.local)
    keepCopy(local, sources.cache)
    installModelFacts(local, 'local')
    return installedFrom
  }
  if (sources.url) {
    lastUrlTry = Date.now()
    try {
      const response = await fetch(sources.url, { signal: AbortSignal.timeout(timeoutMs) })
      const fetched = response.ok ? parseModelFacts(await response.text()) : null
      if (fetched) {
        keepCopy(fetched, sources.cache)
        installModelFacts(fetched, 'url')
        return installedFrom
      }
    } catch {
      // offline or the host is down: the last good copy below
    }
  }
  const cached = readFacts(sources.cache)
  installModelFacts(cached ?? EMPTY, cached ? 'cache' : 'none')
  return installedFrom
}

/**
 * picks up a regenerated models.json while the server runs: a changed local file
 * is reread at once, and a machine without one retries the url every six hours.
 * true when the facts changed.
 */
export async function reloadModelFacts(sources: ModelSources = modelSources()): Promise<boolean> {
  const before = installed
  const mtime = mtimeOf(sources.local)
  if (mtime !== null && mtime !== localMtime) {
    await loadModelFacts(sources)
  } else if (mtime === null && installedFrom !== 'local' && Date.now() - lastUrlTry > 6 * 3600_000) {
    await loadModelFacts(sources)
  }
  return installed !== before && JSON.stringify(installed) !== JSON.stringify(before)
}

/** the facts in use; the first call without an explicit load reads them synchronously */
export function modelFacts(): ModelFacts {
  return installed ?? loadModelFactsSync()
}

// what may follow a known id and still mean that model: a date or a version tag.
// anything else (`-5` after `claude-opus-5`, `-nano` after `gpt-5.4`) is another
// model, and pricing it as its neighbour is how a missing row goes unnoticed
const SUFFIX = /^[-@](\d{6,8}|\d{4}-\d{2}(-\d{2})?|v\d+(:\d+)?|latest)$/

const resolved = new Map<string, string | null>()
let resolvedFor: ModelFacts | null = null

/** `Claude-Fable-5-1[1m]` -> `claude-fable-5-1`, `GPT-6.1 Sol` -> `gpt-6.1-sol` */
export function normalizeModel(id: string): string {
  return id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^(anthropic|openai)\//, '').replace(/\s+/g, '-')
}

/** the canonical id for an id, alias or dated variant, or null when the file does not know it */
export function resolveModel(id: string): string | null {
  const facts = modelFacts()
  if (resolvedFor !== facts) {
    resolved.clear()
    resolvedFor = facts
  }
  const hit = resolved.get(id)
  if (hit !== undefined) return hit
  const key = normalizeModel(id)
  let best: string | null = null
  if (facts.models[key]) best = key
  else if (facts.aliases[key]) best = facts.aliases[key]!
  else {
    for (const known of Object.keys(facts.models)) {
      if (key.startsWith(known) && SUFFIX.test(key.slice(known.length)) && (best === null || known.length > best.length)) best = known
    }
  }
  resolved.set(id, best)
  return best
}

/** the record for a model, or null */
export function modelFact(id: string): ModelFact | null {
  const canonical = resolveModel(id)
  return canonical ? modelFacts().models[canonical]! : null
}
