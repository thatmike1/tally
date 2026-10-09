// speed changes purchased credits and included allowance by different amounts.
// https://learn.chatgpt.com/docs/agent-configuration/speed, read 9 Oct 2026.
import { DatabaseSync } from 'node:sqlite'

export type CodexSpeed = 'standard' | 'fast'

/** null means the recorded tier is absent or unsupported, never a known standard call */
export function codexSpeed(value: unknown): CodexSpeed | null {
  if (value === 'default' || value === 'standard') return 'standard'
  if (value === 'priority' || value === 'fast') return 'fast'
  return null
}

/** purchased credits and API fast prices use 2x; included subscription usage uses 2.5x */
export function speedMultiplier(speed: CodexSpeed | null, included = false): number {
  return speed === 'fast' ? (included ? 2.5 : 2) : 1
}

/** validates JSON objects from T3 and future Codex speed metadata */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function jsonObject(value: unknown): Record<string, unknown> | null {
  return isJsonObject(value) ? value : null
}

function selectionSpeed(value: unknown): CodexSpeed | null {
  const selection = jsonObject(value)
  if (!selection) return null
  const options = selection.options
  if (Array.isArray(options)) {
    const entries = options.map(jsonObject)
    const tier = entries.find((entry) => entry?.id === 'serviceTier')
    if (tier) return codexSpeed(tier.value)
    const fast = entries.find((entry) => entry?.id === 'fastMode')
    if (typeof fast?.value === 'boolean') return fast.value ? 'fast' : 'standard'
  } else {
    const legacy = jsonObject(options)
    if (legacy && 'serviceTier' in legacy) return codexSpeed(legacy.serviceTier)
    if (typeof legacy?.fastMode === 'boolean') return legacy.fastMode ? 'fast' : 'standard'
  }
  // missing options could inherit a CLI default; don't infer today's config for old turns
  return null
}

const cache = new Map<string, { sequence: number; speeds: Map<string, CodexSpeed | null> }>()

/**
 * links the requested speed to the provider turn id recorded by session-set.
 * reads event history rather than the thread's current selection, so toggles,
 * resumes and deleted threads retain their historical speed. root turn ids
 * let a child rollout inherit its parent's recorded tier when its own is absent.
 */
export function t3TurnSpeeds(path: string): Map<string, CodexSpeed | null> {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return new Map()
  }
  try {
    const eventTypes = "('thread.created', 'thread.meta-updated', 'thread.turn-start-requested', 'thread.session-set')"
    const latest = db.prepare(`SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE event_type IN ${eventTypes}`).get()
    const sequence = Number(latest?.sequence ?? 0)
    const previous = cache.get(path)
    if (previous?.sequence === sequence) return previous.speeds
    const selections = new Map<string, unknown>()
    const pending = new Map<string, CodexSpeed | null>()
    const speeds = new Map<string, CodexSpeed | null>()
    for (const row of db.prepare(`SELECT event_type, payload_json FROM orchestration_events WHERE event_type IN ${eventTypes} ORDER BY sequence`).iterate()) {
      let payload: Record<string, unknown> | null
      try {
        payload = jsonObject(JSON.parse(String(row.payload_json)))
      } catch {
        continue
      }
      if (!payload || typeof payload.threadId !== 'string') continue
      const threadId = payload.threadId
      if (payload.modelSelection !== undefined) selections.set(threadId, payload.modelSelection)
      if (row.event_type === 'thread.turn-start-requested') {
        pending.set(threadId, selectionSpeed(selections.get(threadId)))
      } else if (row.event_type === 'thread.session-set' && pending.has(threadId)) {
        const session = jsonObject(payload.session)
        if (session?.providerName !== 'codex' || typeof session.activeTurnId !== 'string') continue
        // a queued request can briefly report the previous active turn again
        if (speeds.has(session.activeTurnId)) continue
        speeds.set(session.activeTurnId, pending.get(threadId) ?? null)
        pending.delete(threadId)
      }
    }
    cache.set(path, { sequence, speeds })
    return speeds
  } catch {
    // missing T3 or an older schema leaves speed explicitly unknown
    return new Map()
  } finally {
    db.close()
  }
}
