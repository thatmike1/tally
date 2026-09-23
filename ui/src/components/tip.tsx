import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * the one hover card on the page. native `title` tooltips are slow, unstyled and
 * unreadable in the dark theme, so nothing here uses them: a number that matters
 * is on the page, and what is left over goes through this.
 */

interface Placed {
  content: ReactNode
  x: number
  y: number
}

/** the card itself, kept inside the window whichever corner the cursor is in */
function Card({ content, x, y }: Placed) {
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x + 14, top: y + 16 })
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    let left = x + 14
    let top = y + 16
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - rect.width - 14)
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 12)
    setAt({ left, top })
  }, [x, y])
  return createPortal(
    <div ref={box} className="tip" role="tooltip" style={at}>
      {content}
    </div>,
    document.body,
  )
}

/**
 * for a chart with many marks: `bind(content)` goes on each mark, `layer` once
 * anywhere in the tree. the card follows the cursor.
 */
export function useTip(): {
  bind: (content: ReactNode) => { onMouseMove: (event: MouseEvent) => void; onMouseLeave: () => void }
  layer: ReactNode
} {
  const [placed, setPlaced] = useState<Placed | null>(null)
  return {
    bind: (content) => ({
      onMouseMove: (event) => setPlaced({ content, x: event.clientX, y: event.clientY }),
      onMouseLeave: () => setPlaced(null),
    }),
    layer: placed ? <Card {...placed} /> : null,
  }
}

/** one piece of text with a card behind it; the text gets a quiet dotted cue */
export function Tip({
  tip,
  children,
  className,
  style,
}: {
  tip: ReactNode
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const { bind, layer } = useTip()
  return (
    <span className={className ? `tip-host ${className}` : 'tip-host'} style={style} {...bind(tip)}>
      {children}
      {layer}
    </span>
  )
}
