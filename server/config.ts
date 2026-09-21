// `~/.config/tally/config.json`: what this machine has installed, what the
// plans cost and where the tray points. every key is optional and every missing
// or broken one falls back to a default, because tally has to run on a machine
// that never wrote the file — and because the file is the user's, not state
// tally owns: `systemd/install.sh` writes it once and never again.
//
// the tray reads the same file from python, so the shape here is a contract
// between three programs. change it in one place and the other two go quiet.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** a subscription the page's dollars are compared against */
export interface PlanConfig {
  name: string
  usdPerMonth: number
}

/** the command that writes the one-line takeaway, and the model it runs */
export interface TakeawayConfig {
  command: string
  model: string
}

/** one tray row: a local service, and the unit that starts it when it is down */
export interface TrayEntry {
  name: string
  url: string
  unit: string | null
}

export interface TrayConfig {
  /** rows that only open their url, starting the unit when the port is closed */
  links: TrayEntry[]
  /** rows that start and stop their unit, for a service that costs something while it runs */
  toggles: TrayEntry[]
}

export interface TallyConfig {
  port: number
  plan: PlanConfig
  codexPlan: PlanConfig
  /** base url of a local AgentsView; null means no transcript links anywhere */
  agentsviewUrl: string | null
  /** null turns the takeaway off, which is what a machine without the command wants */
  takeaway: TakeawayConfig | null
  tray: TrayConfig
}

/** what tally runs on with no config file at all */
export function defaultConfig(): TallyConfig {
  return {
    port: 1337,
    plan: { name: 'Max 5x', usdPerMonth: 100 },
    codexPlan: { name: 'ChatGPT Pro', usdPerMonth: 100 },
    agentsviewUrl: null,
    takeaway: null,
    tray: { links: [], toggles: [] },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function port(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : fallback
}

function plan(value: unknown, fallback: PlanConfig): PlanConfig {
  if (!isRecord(value)) return fallback
  const usd = value.usdPerMonth
  return {
    name: text(value.name) ?? fallback.name,
    usdPerMonth: typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : fallback.usdPerMonth,
  }
}

/** a base url with no trailing slash, so `${base}/sessions/…` never doubles it */
function baseUrl(value: unknown): string | null {
  const raw = text(value)
  return raw === null ? null : raw.replace(/\/+$/, '')
}

function takeaway(value: unknown): TakeawayConfig | null {
  if (!isRecord(value)) return null
  const command = text(value.command)
  const model = text(value.model)
  // a takeaway with no command or no model is off, not half-configured
  return command && model ? { command, model } : null
}

function trayEntries(value: unknown): TrayEntry[] {
  if (!Array.isArray(value)) return []
  const out: TrayEntry[] = []
  for (const row of value) {
    if (!isRecord(row)) continue
    const name = text(row.name)
    const url = text(row.url)
    if (!name || !url) continue
    out.push({ name, url, unit: text(row.unit) })
  }
  return out
}

function tray(value: unknown): TrayConfig {
  if (!isRecord(value)) return { links: [], toggles: [] }
  return { links: trayEntries(value.links), toggles: trayEntries(value.toggles) }
}

/**
 * the config at `path`, with every missing or malformed key defaulted. a file
 * that is not readable json is reported once and then ignored: a typo in it must
 * not stop tally starting, or the page that says what ate the block is the thing
 * that broke.
 */
export function loadConfig(path: string): TallyConfig {
  const base = defaultConfig()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // a missing file is the normal case on a fresh machine and says nothing
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return base
    console.error(`tally: ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return base
  }
  if (!isRecord(raw)) {
    console.error(`tally: ignoring ${path}: the config must be a json object`)
    return base
  }
  return {
    port: port(raw.port, base.port),
    plan: plan(raw.plan, base.plan),
    codexPlan: plan(raw.codexPlan, base.codexPlan),
    agentsviewUrl: baseUrl(raw.agentsviewUrl),
    takeaway: takeaway(raw.takeaway),
    tray: tray(raw.tray),
  }
}

/** where the config lives: `$XDG_CONFIG_HOME/tally/config.json`, else under `~/.config` */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.config'), 'tally', 'config.json')
}

let loaded: TallyConfig | null = null

/**
 * the config this process runs on, read once. it is the user's file rather than
 * state tally keeps, so re-reading it mid-run would only make two requests
 * disagree about what the plan costs.
 */
export function tallyConfig(): TallyConfig {
  loaded ??= loadConfig(defaultConfigPath())
  return loaded
}
