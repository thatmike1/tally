import { useEffect, useRef, useState } from 'react'
import { agentsview, type Lane, type State } from '../api'
import { duration, hm, money, projectName, tokens } from '../format'

const HEIGHT = 140
const LABELS = 230
const RIGHT_PAD = 20
const BASELINE = 120
const TOP = 8
const MAX_ROWS = 42

/** the meter line and the day lanes, on one day axis */
export function Day({ state }: { state: State }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1300)
  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(600, entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { start, end } = state.day
  const resets = resetsCrossed(state)
  const x = (t: number) => LABELS + ((t - start) / (end - start)) * (width - LABELS - RIGHT_PAD)
  const y = (pct: number) => BASELINE - pct * ((BASELINE - TOP) / 100)

  return (
    <div ref={box}>
      <h2 style={{ marginTop: 44 }}>today on the clock</h2>
      {resets ? (
        <p className="calc">
          {resets}
          <small>computed, no model</small>
        </p>
      ) : null}
      <Chart state={state} width={width} x={x} y={y} />
      <Lanes state={state} />
    </div>
  )
}

/** the numbers-only line: 5-hour resets crossed today. the weekly meters moved to the week section */
function resetsCrossed(state: State): string | null {
  const points = state.day.meter
  if (!points.length) return 'no api meter samples yet today.'
  const bits: string[] = []
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!
    const current = points[i]!
    if (current.resetKey !== previous.resetKey) {
      if (previous.pct >= 100) bits.push(`hit 100% before ${hm(previous.resetKey)}`)
      bits.push(`reset at ${hm(previous.resetKey)}`)
    }
  }
  if (!bits.length) return null
  const line = bits.join(', ')
  return `${line[0]!.toUpperCase()}${line.slice(1)}.`
}

function Chart({
  state,
  width,
  x,
  y,
}: {
  state: State
  width: number
  x: (t: number) => number
  y: (pct: number) => number
}) {
  const { start, end, meter } = state.day
  // one polyline per block: the drop at a reset is a break in the series, not a
  // line the meter actually traced
  const segments: (typeof meter)[] = []
  for (const point of meter) {
    const last = segments.at(-1)
    if (last && last[0]!.resetKey === point.resetKey) last.push(point)
    else segments.push([point])
  }
  const ticks: number[] = []
  for (let t = start; t < end; t += 3 * 3600) if (t > start) ticks.push(t)
  const block = state.block
  const lastPoint = meter.at(-1)
  const showProjection = block && lastPoint && block.resetsAt <= end && lastPoint.resetKey === block.resetsAt

  return (
    <svg width={width} height={HEIGHT}>
      {ticks.map((t) => (
        <g key={t}>
          <text x={x(t)} y={HEIGHT - 4} className="tk">
            {hm(t)}
          </text>
          <line x1={x(t)} x2={x(t)} y1={TOP} y2={BASELINE - 2} className="grid" />
        </g>
      ))}
      <line x1={LABELS} x2={width - RIGHT_PAD} y1={y(100)} y2={y(100)} className="grid" />
      <line x1={LABELS} x2={width - RIGHT_PAD} y1={y(50)} y2={y(50)} className="grid" />
      <text x={LABELS - 24} y={y(100) + 4} className="tk">
        100
      </text>
      <text x={LABELS - 20} y={y(50) + 4} className="tk">
        50
      </text>
      {segments.map((segment) => (
        <polyline
          key={segment[0]!.t}
          className="h5"
          points={segment.map((p) => `${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')}
        />
      ))}
      {showProjection ? (
        <polyline
          className="pj"
          points={`${x(lastPoint.t).toFixed(1)},${y(lastPoint.pct).toFixed(1)} ${x(block.resetsAt).toFixed(1)},${y(
            block.projection.pctAtReset,
          ).toFixed(1)}`}
        />
      ) : null}
      {state.lastLooked && state.lastLooked >= start && state.lastLooked < end ? (
        <g>
          <line x1={x(state.lastLooked)} x2={x(state.lastLooked)} y1={TOP} y2={BASELINE - 2} className="mk" />
          {/* dropped a line when the reset marker is close enough to collide */}
          <text
            x={x(state.lastLooked) + 4}
            y={block && Math.abs(x(block.resetsAt) - x(state.lastLooked)) < 110 ? 32 : 18}
            className="tk"
          >
            last looked
          </text>
        </g>
      ) : null}
      {block && block.resetsAt <= end ? (
        <g>
          <line x1={x(block.resetsAt)} x2={x(block.resetsAt)} y1={TOP} y2={BASELINE - 2} className="mk" />
          <text x={x(block.resetsAt) - 6} y={18} textAnchor="end" className="tk">
            reset
          </text>
        </g>
      ) : null}
    </svg>
  )
}

/** the thin parent line, in px; every subagent transcript inside a segment adds to it */
const LANE_THIN = 4
const LANE_STEP = 3
const LANE_FAT = 14

/** a stretch too short to see still has to be clickable */
const MIN_SEGMENT_PCT = 0.25

function segmentHeight(agents: number): number {
  return Math.min(LANE_FAT, LANE_THIN + agents * LANE_STEP)
}

/** seconds this lane was actually working, which is the sum of its segments */
function activeSeconds(lane: Lane): number {
  return lane.segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0)
}

function laneTitle(lane: Lane): string {
  if (lane.cost === null) {
    return `${lane.kind} · ${duration(lane.end - lane.start)}${lane.live ? ' · live' : ''}`
  }
  const bits = [
    `${tokens(lane.tokens ?? 0)} tokens`,
    money(lane.cost),
    `${lane.requests} request${lane.requests === 1 ? '' : 's'}`,
    `${duration(activeSeconds(lane))} active`,
  ]
  if (lane.agents) bits.push(`${lane.agents} agent${lane.agents === 1 ? '' : 's'}`)
  return bits.join(' · ')
}

function laneLabel(lane: Lane): string {
  if (lane.cost === null) return `${duration(lane.end - lane.start)} · ${lane.kind}`
  return [
    duration(activeSeconds(lane)),
    lane.agents ? `${lane.agents} agent${lane.agents === 1 ? '' : 's'}` : null,
    money(lane.cost),
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * the day's sessions as activity: one segment per stretch of requests, thicker
 * where subagent transcripts were writing inside it, and never a bar from the
 * first message to the last with three idle hours in the middle.
 */
function Lanes({ state }: { state: State }) {
  const { lanes, start, end } = state.day
  if (!lanes.length) return <p className="more">no sessions on the clock today yet.</p>
  const span = end - start
  const groups = new Map<string, Lane[]>()
  for (const lane of lanes) {
    const key = projectName(lane.project)
    const list = groups.get(key)
    if (list) list.push(lane)
    else groups.set(key, [lane])
  }
  const ordered = [...groups.entries()]
    .map(([name, rows]) => ({
      name,
      rows: [...rows].sort((a, b) => a.start - b.start),
      cost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
    }))
    .sort((a, b) => b.cost - a.cost)
  const maxCost = Math.max(0.01, ...lanes.map((lane) => lane.cost ?? 0))

  let drawn = 0
  return (
    <>
      {ordered.map((group) => {
        const room = Math.max(0, MAX_ROWS - drawn)
        const rows = group.rows.slice(0, room)
        const hidden = group.rows.length - rows.length
        drawn += rows.length
        return (
          <div key={group.name}>
            <div className="grp">
              {group.name}
              <span>
                {group.rows.length} session{group.rows.length === 1 ? '' : 's'} · {money(group.cost)}
              </span>
            </div>
            {rows.map((lane) => {
              const other = lane.cost === null
              // brightness by cost, as in v1; a thread with no cost stays flat
              const opacity = other ? 0.55 : 0.4 + 0.36 * Math.sqrt(Math.min(1, (lane.cost ?? 0) / maxCost))
              const href = other ? null : `#/session/${lane.id}`
              const title = laneTitle(lane)
              const last = lane.segments.at(-1)!
              const labelLeft = Math.min(97, ((Math.min(last.end, end) - start) / span) * 100)
              const bar = (
                <>
                  {lane.segments.map((segment) => {
                    const left = ((Math.max(segment.start, start) - start) / span) * 100
                    const right = ((Math.min(segment.end, end) - start) / span) * 100
                    const width = Math.max(MIN_SEGMENT_PCT, right - left)
                    const height = other ? LANE_THIN : segmentHeight(segment.agents)
                    return (
                      <i
                        key={segment.start}
                        className={other ? 'other' : undefined}
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          opacity,
                          height,
                          top: (LANE_FAT - height) / 2,
                        }}
                      />
                    )
                  })}
                  <em style={{ left: `calc(${labelLeft}% + 6px)` }}>{laneLabel(lane)}</em>
                </>
              )
              return (
                <div className="lr" key={`${lane.kind}-${lane.id}`}>
                  <div className="lt">
                    {href ? (
                      <a href={href} title={title}>
                        {lane.title}
                      </a>
                    ) : (
                      <span title={title}>{lane.title}</span>
                    )}
                    {other ? null : (
                      <a className="av" href={agentsview(lane.id)} title="open the transcript in AgentsView">
                        ↗
                      </a>
                    )}
                  </div>
                  {href ? (
                    <a className="lb" href={href} title={title}>
                      {bar}
                    </a>
                  ) : (
                    <div className="lb" title={title}>
                      {bar}
                    </div>
                  )}
                </div>
              )
            })}
            {hidden > 0 ? <span className="more">… {hidden} more, past the rows this page draws</span> : null}
          </div>
        )
      })}
    </>
  )
}
