import type { State } from '../../server/state'

export type { State }
export type SessionRow = State['split'] extends { sessions: (infer T)[] } | null ? T : never
export type OtherRow = State['others'][number]
export type Lane = State['day']['lanes'][number]

/**
 * `peek` reads the state without moving the "last looked" marker. the first load
 * of a page marks the look; the polls after it must not, or the marker would
 * always sit on now and say nothing.
 */
export async function fetchState(peek: boolean): Promise<State> {
  const response = await fetch(peek ? '/api/state?peek' : '/api/state')
  if (!response.ok) throw new Error(`tally server answered ${response.status}`)
  return (await response.json()) as State
}

export function agentsview(sessionId: string): string {
  return `http://127.0.0.1:8080/sessions/${sessionId}?msg=last`
}
