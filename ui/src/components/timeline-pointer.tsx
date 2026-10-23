// dragging and hovering on any plot of the timeline: the chart and every lane
// share one axis, so a drag that starts on a lane reads the same range as one
// on the chart, and the crosshair follows the pointer across all of them.
//
// a plain drag reads a range, as it always has. a drag that starts on the time
// axis under the chart, with shift held, or with the middle button moves the
// view instead: the axis is where a time axis is grabbed, and shift keeps a pan
// one key away from anywhere on the plots without taking the plain drag.
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
  /** the view a pan has moved to, from where it was when the pan started */
  onPan: (view: Span) => void
}

/** a press that pans rather than reads: shift, the middle button, or the chart's time axis */
export function pansFrom(event: { button: number; shiftKey: boolean; target: EventTarget | null }): boolean {
  if (event.button === 1) return true
  if (event.button !== 0) return false
  return event.shiftKey || (event.target instanceof Element && event.target.closest('.tl-axis-band') !== null)
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
  const pan = useRef<{ x: number; view: Span; width: number; id: number } | null>(null)
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
      if (pansFrom(event)) {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const box = event.currentTarget.getBoundingClientRect()
        pan.current = { x: event.clientX, view: latest.current.view, width: box.width, id: event.pointerId }
        document.body.classList.add('tl-panning')
        latest.current.onHover(null, null, null)
        return
      }
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { start: timeAt(event, latest.current.view), x: event.clientX, moved: false, id: event.pointerId }
    },
    onPointerMove: (event) => {
      const panning = pan.current
      if (panning && panning.id === event.pointerId) {
        const seconds = ((panning.x - event.clientX) / panning.width) * (panning.view.to - panning.view.from)
        latest.current.onPan({ from: panning.view.from + seconds, to: panning.view.to + seconds })
        return
      }
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
      if (pan.current?.id === event.pointerId) {
        pan.current = null
        document.body.classList.remove('tl-panning')
        return
      }
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
      if (!drag.current && !pan.current) latest.current.onHover(null, null, null)
    },
    onPointerCancel: () => {
      drag.current = null
      pan.current = null
      document.body.classList.remove('tl-panning')
      latest.current.onBrush(null)
      latest.current.onHover(null, null, null)
    },
  })
}
