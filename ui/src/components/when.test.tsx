// the block chart colours a Codex lane like its row in the Codex ledger, found by T3 thread id
import { describe, expect, it } from 'vitest'
import type { Lane, State } from '../api'
import { laneColor } from './when'

const lane = { id: 't3-b', kind: 'codex', title: 'Review' } as Lane
const state = {
  split: null,
  codex: {
    split: {
      threads: [
        { id: 'codex-a', t3ThreadId: 't3-a', title: 'Review', color: '#3c6e9e' },
        { id: 'codex-b', t3ThreadId: 't3-b', title: 'Review', color: '#7f9fc0' },
      ],
    },
  },
} as unknown as State

describe('laneColor', () => {
  it('takes the colour of the thread T3 ran, not the first with the same title', () => {
    expect(laneColor(state, lane)).toBe('#7f9fc0')
  })

  it('falls back to the Codex colour when the split has no such thread', () => {
    expect(laneColor(state, { ...lane, id: 't3-z' })).toBe('var(--codex)')
  })
})
