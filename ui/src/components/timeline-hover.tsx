// the styled hover card and what it says over the chart, a lane or a block
// tile. every number in it is also on the page; the card is the crosshair's
// readout and the "what happens if I click" line, never the only place a
// figure lives.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BlockSummary, Lane, RangeLanes } from '../api'
import { dayDate, duration, hm, money, rate, tokens } from '../format'
import { readingAt } from './timeline-chart'
import { dayStart } from './timeline-util'

export interface Hover {
  /** viewport pixels of the pointer */
  x: number
  y: number
  body: ReactNode
}

/** a card that follows the pointer and flips away from the window's edges */
export function HoverCard({ hover }: { hover: Hover | null }) {
  const card = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect()
    if (box && (box.width !== size.width || box.height !== size.height)) setSize({ width: box.width, height: box.height })
  })
  if (!hover) return null
  let left = hover.x + 16
  let top = hover.y + 18
  if (left + size.width > window.innerWidth - 8) left = hover.x - size.width - 16
  if (top + size.height > window.innerHeight - 8) top = hover.y - size.height - 14
  return (
    <div ref={card} className="tl-tip" style={{ left, top }} role="tooltip">
      {hover.body}
    </div>
  )
}

/** `13:05`, or `Tue 22 Sep 13:05` when it is not today */
export function when(t: number, now: number): string {
  return dayStart(t) === dayStart(now) ? hm(t) : `${dayDate(t)} ${hm(t)}`
}

type MeterPoint = RangeLanes['meter'][number]

function blockAt(blocks: BlockSummary[], t: number): BlockSummary | undefined {
  return blocks.find((b) => t >= b.start && t < b.resetKey)
}

/** over the chart: the readings at the crosshair, the block it sits in, and who was working */
export function chartHover(t: number, meter: MeterPoint[], blocks: BlockSummary[], lanes: Lane[], now: number): ReactNode {
  const reading = readingAt(meter, t, blocks)
  const block = blockAt(blocks, t)
  const active = lanes.filter((lane) => lane.segments.some((s) => t >= s.start - 60 && t <= s.end + 60))
  return (
    <>
      <b>{when(t, now)}</b>
      {reading ? (
        <div className="tl-tip-nums">
          5-hour {reading.pct}%{reading.weeklyPct !== null ? ` · weekly ${reading.weeklyPct}%` : ''}
          {reading.scopedPct !== null ? ` · Fable ${reading.scopedPct}%` : ''}
        </div>
      ) : (
        <div className="tl-tip-dim">no reading here</div>
      )}
      {block ? (
        <div>
          block {hm(block.start)}–{hm(block.resetKey)}: {block.ended ? `ended ${block.endPct}%` : `${block.endPct}% so far`}
          {block.delta !== null ? `, +${block.delta}` : ''} · {money(block.usage.cost)} list
        </div>
      ) : null}
      {active.length ? (
        <div className="tl-tip-dim">
          working: {active.slice(0, 4).map((lane) => lane.shortTitle ?? lane.title.slice(0, 40)).join(', ')}
          {active.length > 4 ? ` and ${active.length - 4} more` : ''}
        </div>
      ) : null}
      <div className="tl-tip-hint">drag to read a range · click to read this block</div>
    </>
  )
}

/** over a lane: the segment under the pointer, or where the session idled */
export function laneHover(t: number, lane: Lane | null, title: string, now: number, pxPerSecond: number): ReactNode {
  // a segment a few pixels wide still catches the pointer
  const slack = Math.max(60, 4 / pxPerSecond)
  const segment = lane?.segments.find((s) => t >= s.start - slack && t <= s.end + slack)
  const claude = lane?.kind === 'claude'
  return (
    <>
      <b>{title}</b>
      <div className="tl-tip-dim">{when(t, now)}</div>
      {segment ? (
        <div className="tl-tip-nums">
          {hm(segment.start)}–{hm(segment.end)} · {duration(segment.end - segment.start)}
          {claude ? ` · ${money(segment.cost)} · ${segment.requests} requests` : ` · ${lane?.kind}, no Claude usage`}
          {segment.agents ? ` · ${segment.agents} subagent${segment.agents === 1 ? '' : 's'} running` : ''}
        </div>
      ) : (
        <div className="tl-tip-dim">idle here</div>
      )}
      {lane && claude ? (
        <div className="tl-tip-dim">
          on screen: {money(lane.cost)} · {tokens(lane.tokens ?? 0)} tokens · {lane.requests} requests
        </div>
      ) : null}
      <div className="tl-tip-hint">
        {segment ? 'click to read this stretch' : 'click to read this block'} · drag to read a range · the title opens the session
      </div>
    </>
  )
}

/** over a block tile: what the block did and whether its cost per point is measured */
export function blockHover(block: BlockSummary, current: boolean, now: number): ReactNode {
  return (
    <>
      <b>
        {when(block.start, now)}–{hm(block.resetKey)}
      </b>
      <div className="tl-tip-nums">
        {block.startPct}% → {block.endPct}%{block.delta !== null ? ` · +${block.delta}` : ''}
        {current ? ' so far' : ''} · {money(block.usage.cost)} list · {block.usage.requests} requests
      </div>
      <div className="tl-tip-dim">
        {block.dollarsPerPercent !== null
          ? `${rate(block.dollarsPerPercent)} of list price per point`
          : block.saturated
            ? 'hit 100%, so the points are a floor'
            : 'cost per point not measured: a sampler gap, one reading or no movement'}
      </div>
      <div className="tl-tip-hint">click to read this block</div>
    </>
  )
}
