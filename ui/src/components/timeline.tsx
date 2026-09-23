// the timeline tab: the meter chart, the block strip and the lanes on one time
// axis, where a dragged range re-reads the split. placeholder until built.

export function Timeline({ from, to }: { from: number | undefined; to: number | undefined }) {
  return <p className="muted">timeline {from !== undefined && to !== undefined ? `${from}–${to}` : 'current block'}</p>
}
