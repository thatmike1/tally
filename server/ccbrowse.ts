// the day lanes come from cc-browse's running server, unchanged: one bar per
// session on the day axis, agent intervals and cost already merged.
//
// this is a dependency on another process, and v1 accepts it. folding the index
// in would mean re-implementing cc-browse's session table here; the README says
// so.
export interface LaneAgent {
  start: string
  end: string
  active: boolean
}

export interface Lane {
  id: string
  title: string
  project: string
  created: string
  modified: string
  active: boolean
  n_msgs: number
  n_agents: number
  tokens: number
  cost: number | null
  agents: LaneAgent[]
}

export interface LanesResult {
  lanes: Lane[]
  /** null when cc-browse answered; a message the page can print when it did not */
  error: string | null
}

export const DEFAULT_CCBROWSE = 'http://127.0.0.1:4173'

export async function dayLanes(from: number, to: number, base = DEFAULT_CCBROWSE): Promise<LanesResult> {
  const url = new URL('/api/timeline', base)
  url.searchParams.set('start', new Date(from * 1000).toISOString())
  url.searchParams.set('end', new Date(to * 1000).toISOString())
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { lanes: [], error: `cc-browse answered ${response.status}` }
    const body = (await response.json()) as { sessions?: Lane[]; error?: string }
    if (body.error) return { lanes: [], error: body.error }
    return { lanes: body.sessions ?? [], error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { lanes: [], error: `cc-browse is not answering on ${base} (${message})` }
  }
}
