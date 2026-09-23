// dragging and hovering on any plot of the timeline: the chart and every lane
// share one axis, so a drag that starts on a lane reads the same range as one
// on the chart, and the crosshair follows the pointer across all of them.
import { useRef } from 'react'
import { clamp, snap, type Span } from './timeline-util'

export interface PlotHandlers {
  onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerLeave: (event: React.PointerEvent<SVGSVGElement>) => void
  onPointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void
}

export interface PointerOptions {
  view: Span
  /** drag ends snap to this many seconds */
  step: number
  now: number
  /** the drag in progress, or null when it ends; drawn as a dashed box on every plot */
  onBrush: (brush: Span | null) => void
  /** the pointer's time over a plot, or null when it leaves */
  onHover: (t: number | null, event: React.PointerEvent | null, laneId: string | null) => void
  /** a finished drag */
  onPick: (range: Span) => void
  /** a press and release without a drag */
  onClick: (t: number, laneId: string | null) => void
}

/** pixels the pointer has to travel before a press counts as a drag */
const DRAG_PX = 5

function timeAt(event: React.PointerEvent<SVGSVGElement>, view: Span): number {
  const box = event.currentTarget.getBoundingClientRect()
  const fraction = clamp((event.clientX - box.left) / box.width, 0, 1)
  return view.from + fraction * (view.to - view.from)
}

/** handlers for one plot; `laneId` says which lane a click or hover belongs to */
export function usePlotPointer(options: PointerOptions): (laneId: string | null) => PlotHandlers {
  const drag = useRef<{ start: number; x: number; moved: boolean; id: number } | null>(null)
  const latest = useRef(options)
  latest.current = options

  const span = (a: number, b: number): Span => {
    const { step, now, view } = latest.current
    const from = snap(Math.min(a, b), step)
    const to = Math.min(snap(Math.max(a, b), step), now)
    return { from: Math.max(view.from, from), to }
  }

  return (laneId) => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { start: timeAt(event, latest.current.view), x: event.clientX, moved: false, id: event.pointerId }
    },
    onPointerMove: (event) => {
      const t = timeAt(event, latest.current.view)
      const current = drag.current
      if (current && current.id === event.pointerId) {
        if (Math.abs(event.clientX - current.x) > DRAG_PX) current.moved = true
        if (current.moved) {
          latest.current.onBrush(span(current.start, t))
          latest.current.onHover(t, null, laneId)
          return
        }
      }
      latest.current.onHover(t, event, laneId)
    },
    onPointerUp: (event) => {
      const current = drag.current
      drag.current = null
      if (!current || current.id !== event.pointerId) return
      const t = timeAt(event, latest.current.view)
      latest.current.onBrush(null)
      if (current.moved) {
        const range = span(current.start, t)
        if (range.to - range.from >= 60) latest.current.onPick(range)
        return
      }
      latest.current.onClick(t, laneId)
    },
    onPointerLeave: () => {
      if (!drag.current) latest.current.onHover(null, null, null)
    },
    onPointerCancel: () => {
      drag.current = null
      latest.current.onBrush(null)
      latest.current.onHover(null, null, null)
    },
  })
}
