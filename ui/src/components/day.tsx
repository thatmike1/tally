import { useEffect, useRef, useState } from 'react'
import { agentsview, type Lane, type State } from '../api'
import { duration, hm, money, projectName, tokens } from '../format'

const HEIGHT = 140
const LABELS = 230
const RIGHT_PAD = 20
const BASELINE = 120
const TOP = 8
const MAX_ROWS = 42

/** the meter line and cc-browse's day lanes, on one day axis */
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
  const x = (t: number) => LABELS + ((t - start) / (end - start)) * (width - LABELS - RIGHT_PAD)
  const y = (pct: number) => BASELINE - pct * ((BASELINE - TOP) / 100)

  return (
    <div ref={box}>
      <h2 style={{ marginTop: 44 }}>today on the clock</h2>
      <p className="calc">
        {sentence(state)}
        <small>computed, no model</small>
      </p>
      <Chart state={state} width={width} x={x} y={y} />
      <Lanes state={state} />
    </div>
  )
}

/** the numbers-only line: resets crossed today and what the weekly meters did */
function sentence(state: State): string {
  const points = state.day.meter
  if (!points.length) return 'no api meter samples yet today.'
  const bits: string[] = []
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!
    const current = points[i]!
    if (current.resetKey !== previous.resetKey) {
      if (previous.pct >= 100) bits.push(`Hit 100% before ${hm(previous.resetKey)}`)
      bits.push(`reset at ${hm(previous.resetKey)}`)
    }
  }
  const first = points[0]!
  const last = points.at(-1)!
  const meters: string[] = []
  if (first.weeklyPct !== null && last.weeklyPct !== null) {
    meters.push(`Weekly ${Math.round(first.weeklyPct)} → ${Math.round(last.weeklyPct)}`)
  }
  if (first.scopedPct !== null && last.scopedPct !== null) {
    meters.push(`${state.fable?.model ?? 'Fable'} ${Math.round(first.scopedPct)} → ${Math.round(last.scopedPct)}`)
  }
  const head = bits.length ? `${bits.join(', ')}. ` : ''
  const tail = meters.length ? `${meters.join(', ')} since ${hm(first.t)}.` : ''
  return `${head}${tail}` || 'the meter has not moved today.'
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

function Lanes({ state }: { state: State }) {
  const { lanes, lanesError, start, end } = state.day
  if (lanesError) return <p className="warn">{lanesError}</p>
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
      rows: [...rows].sort((a, b) => Date.parse(a.created) - Date.parse(b.created)),
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
              const from = Date.parse(lane.created) / 1000
              const to = Date.parse(lane.modified) / 1000
              const left = ((Math.max(from, start) - start) / span) * 100
              const right = ((Math.min(to, end) - start) / span) * 100
              const width = Math.max(0.3, right - left)
              const opacity = 0.4 + 0.36 * Math.sqrt(Math.min(1, (lane.cost ?? 0) / maxCost))
              const label = [
                duration(to - from),
                lane.n_agents ? `${lane.n_agents} agent${lane.n_agents === 1 ? '' : 's'}` : null,
                money(lane.cost),
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <div className="lr" key={lane.id}>
                  <div className="lt">
                    <a href={agentsview(lane.id)} title={`${tokens(lane.tokens)} tokens · ${money(lane.cost)}`}>
                      {lane.title}
                    </a>
                  </div>
                  <div className="lb">
                    <i style={{ left: `${left}%`, width: `${width}%`, opacity }} />
                    <em style={{ left: `calc(${left + width}% + 6px)` }}>{label}</em>
                  </div>
                </div>
              )
            })}
            {hidden > 0 ? <span className="more">… {hidden} more rows, as in cc-browse</span> : null}
          </div>
        )
      })}
    </>
  )
}
