// known events affecting comparisons; dates use Europe/Prague midnight.
// append future launches or resets here with a stable id and an exclusive end.
import type { HistoryAnnotation } from './history-types'

export const HISTORY_ANNOTATIONS: HistoryAnnotation[] = [
  {
    id: 't3-entrypoint-penalty',
    start: Date.parse('2026-10-12T00:00:00+02:00') / 1000,
    end: Date.parse('2026-11-06T00:00:00+01:00') / 1000,
    label: 'T3 entrypoint penalty',
    explanation: 'From about 12 Oct, sdk-ts runs burned the 5-hour meter about 2.3× faster per unit of work and the weekly meter somewhat faster. Desktop fixed 2 Nov; laptop fixed 5 Nov. Affected weeks are not a current baseline; the week ending 7 Nov mixes eras.',
  },
]

export function annotationsFor(annotations: HistoryAnnotation[], start: number, end: number): HistoryAnnotation[] {
  return annotations.filter((event) => event.start < end && event.end > start)
}
