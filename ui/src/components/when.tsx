import { useRef } from 'react'
import type { Lane, State } from '../api'
import { hm, money } from '../format'
import { sessionHref, timelineHref } from '../route'
import { useWidth } from './charts'
import { Question } from './ledger'
import { useTip } from './tip'
import { activeLabel, activeWithin, clip, listOf, plural, steepestClimb } from './words'

/**
 * "when did it happen", kept small: the block's meter line with the steepest
 * climb marked, and one thin row per session under it. the whole day and any
 * range live in the timeline tab; this only has to say when inside the block.
 */

/** local-clock ticks every `step` seconds inside `from..to`; offsets are whole minutes, so seconds carry over */
function ticks(from: number, to: number, step: number): number[] {
  const [hours, minutes] = hm(from).split(':')
  const local = Number(hours) * 3600 + Number(minutes) * 60 + (Math.floor(from) % 60)
  const out: number[] = []
  for (let t = from + ((step - (local % step)) % step); t <= to; t += step) out.push(t)
  return out
}

/** a lane's name as it reads on the page: the T3 title when there is one */
function laneName(lane: Lane): string {
  return lane.shortTitle ?? clip(lane.title, 40)
}

/** the colour a lane takes: its split row's, so the chart matches the ledger */
function laneColor(state: State, lane: Lane): string {
  if (lane.kind === 'claude') {
    return state.split?.sessions.find((row) => row.sessionId === lane.id)?.color ?? 'var(--faint)'
  }
  if (lane.kind === 'codex') {
    return state.codex.split?.threads.find((thread) => thread.title === lane.title)?.color ?? 'var(--codex)'
  }
  return 'var(--faint)'
}

const LABELS = 210
const SUFFIX = 230
const TOP = 18
const METER = 118
const LANE_ROW = 24
const MAX_LANES = 9

export function WhenSection({ state, frozen }: { state: State; frozen: boolean }) {
  const block = state.block
  if (!block) return null
  const end = Math.min(state.now, block.resetsAt)
  const climb = steepestClimb(block.samples)
  const lanes = state.day.lanes
    .filter((lane) => lane.segments.some((one) => one.end > block.start && one.start < end))
    .sort((a, b) => a.segments[0]!.start - b.segments[0]!.start)
  const climbers = climb
    ? lanes
        .map((lane) => ({ lane, overlap: activeWithin(lane.segments, climb.from - 300, climb.to) }))
        .filter((one) => one.overlap >= 240)
        .sort((a, b) => b.overlap - a.overlap)
        .map((one) => laneName(one.lane))
    : []
  const timeline = frozen ? timelineHref(block.start, block.resetsAt) : timelineHref()

  return (
    <Question
      id="q-when"
      title="When did it happen"
      lead={
        climb ? (
          <>
            The meter climbed fastest from{' '}
            <b>
              {hm(climb.from)} to {hm(climb.to)}
            </b>
            , {Math.round(climb.startPct)}% to {Math.round(climb.endPct)}%
            {climbers.length ? `, while ${listOf(climbers)} ${climbers.length === 1 ? 'was' : 'were'} working` : ''}.
          </>
        ) : block.samples.length < 2 ? (
          'One meter reading in this block so far, so there is no climb to point at yet.'
        ) : (
          'The meter has not moved inside this block.'
        )
      }
      aside={
        <>
          <div className="aside">
            The line is the 5-hour meter
            {block.projection.ready && !frozen ? ', dashed to the reset at this block’s pace' : ''}. Under it, each
            session’s stretches of work, thicker where subagents ran.
          </div>
          <a className="go-link" href={timeline}>
            {frozen ? 'this block on the timeline →' : 'the whole day on the timeline →'}
          </a>
        </>
      }
    >
      <BlockChart state={state} lanes={lanes} climb={climb} frozen={frozen} />
    </Question>
  )
}

function BlockChart({
  state,
  lanes,
  climb,
  frozen,
}: {
  state: State
  lanes: Lane[]
  climb: ReturnType<typeof steepestClimb>
  frozen: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box, 600)
  const { bind, layer } = useTip()
  const block = state.block!
  const a = block.start
  const b = block.resetsAt
  const plot = width - LABELS - SUFFIX
  const x = (t: number) => LABELS + ((Math.min(Math.max(t, a), b) - a) / (b - a)) * plot
  const y = (pct: number) => TOP + METER - (Math.min(100, pct) / 100) * METER
  const shown = lanes.slice(0, MAX_LANES)
  const last = block.samples.at(-1)
  const laneTop = TOP + METER + 40
  const height = laneTop + shown.length * LANE_ROW + 6

  const samples = block.samples
  const path = samples
    .map((point, index) => (index ? `H${x(point.t).toFixed(1)}V${y(point.pct).toFixed(1)}` : `M${x(point.t).toFixed(1)},${y(point.pct).toFixed(1)}`))
    .join('')
  const area = last ? `${path}H${x(last.t).toFixed(1)}V${y(0)}H${x(samples[0]!.t).toFixed(1)}Z` : ''
  const projection = block.projection
  const showProjection = !frozen && last && projection.ready && !state.fiveHour?.ended
  const now = frozen ? null : state.now
  const maxRate = Math.max(
    1e-9,
    ...shown.flatMap((lane) => lane.segments.map((one) => one.cost / Math.max(60, one.end - one.start))),
  )

  return (
    <div className="chart" ref={box}>
      <svg width={width} height={height}>
        {ticks(a, b, 1800).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP} y2={height} className="grid" />
            {Math.abs(x(t) - x(b)) > 50 ? (
              <text x={x(t)} y={TOP + METER + 20} textAnchor="middle" className="tk">
                {hm(t)}
              </text>
            ) : null}
          </g>
        ))}
        {[0, 50, 100].map((pct) => (
          <g key={pct}>
            <line x1={LABELS} x2={LABELS + plot} y1={y(pct)} y2={y(pct)} className="grid" />
            <text x={LABELS - 10} y={y(pct) + 4} textAnchor="end" className="tk">
              {pct}%
            </text>
          </g>
        ))}
        <text x={0} y={TOP + 10} className="lbl-strong">
          5-hour meter
        </text>
        {climb ? (
          <g>
            <rect x={x(climb.from)} y={TOP} width={Math.max(2, x(climb.to) - x(climb.from))} height={METER} className="climb" />
            <text x={(x(climb.from) + x(climb.to)) / 2} y={TOP - 4} textAnchor="middle" className="lbl">
              +{Math.round(climb.endPct - climb.startPct)} in {Math.round((climb.to - climb.from) / 60)}m
            </text>
          </g>
        ) : null}
        {area ? <path d={area} className="meter-area" /> : null}
        {path ? <path d={path} className="meter-line" /> : null}
        {showProjection && last ? (
          <>
            <line x1={x(last.t)} y1={y(last.pct)} x2={x(b)} y2={y(projection.pctAtReset)} className="meter-proj" />
            <text x={x(b) + 8} y={y(projection.pctAtReset) + 4} className="lbl">
              ≈ {Math.round(projection.pctAtReset)}% at reset
            </text>
          </>
        ) : null}
        {last ? (
          <>
            <circle cx={x(last.t)} cy={y(last.pct)} r={4} className="meter-dot" />
            <text
              x={x(last.t) - LABELS < 140 ? x(last.t) + 8 : x(last.t) - 8}
              y={y(last.pct) < TOP + 24 ? y(last.pct) + 18 : y(last.pct) - 9}
              textAnchor={x(last.t) - LABELS < 140 ? 'start' : 'end'}
              className="lbl-strong"
            >
              {Math.round(last.pct)}% at {hm(last.t)}
            </text>
          </>
        ) : null}
        {now !== null && now < b ? (
          <g>
            <line x1={x(now)} x2={x(now)} y1={TOP} y2={height} className="now" />
            {/* the climb label owns the top edge when the two would touch */}
            {!climb || Math.abs(x(now) - (x(climb.from) + x(climb.to)) / 2) > 90 ? (
              <text x={x(now)} y={TOP - 4} textAnchor="middle" className="tk">
                now
              </text>
            ) : null}
          </g>
        ) : null}
        <line x1={x(b)} x2={x(b)} y1={TOP} y2={height} className="reset" />
        <text x={x(b)} y={TOP + METER + 20} textAnchor="middle" className="lbl-strong">
          reset {hm(b)}
        </text>
        {shown.map((lane, index) => {
          const mid = laneTop + index * LANE_ROW + LANE_ROW / 2
          const color = laneColor(state, lane)
          const name = clip(laneName(lane), 30)
          const active = activeWithin(lane.segments, a, Math.min(b, state.now))
          const claude = lane.kind === 'claude'
          return (
            <g key={`${lane.kind}-${lane.id}`}>
              <line x1={LABELS} x2={LABELS + plot} y1={mid} y2={mid} className="lane-rule" />
              {claude ? (
                <a href={sessionHref(lane.id, frozen ? state.now : undefined)}>
                  <text x={0} y={mid + 4.5} className="lane-lbl">
                    {name}
                  </text>
                </a>
              ) : (
                <text x={0} y={mid + 4.5} className="lane-lbl other">
                  {name}
                </text>
              )}
              {lane.segments
                .filter((one) => one.end > a && one.start < b)
                .map((one) => {
                  const left = x(one.start)
                  const right = Math.max(x(one.end), left + 3)
                  const thick = claude && one.agents > 0 ? 14 : 8
                  const opacity = claude ? 0.5 + (0.5 * one.cost) / Math.max(60, one.end - one.start) / maxRate : 0.8
                  return (
                    <rect
                      key={one.start}
                      x={left}
                      y={mid - thick / 2}
                      width={right - left}
                      height={thick}
                      rx={2}
                      fill={color}
                      opacity={opacity}
                      {...bind(
                        <>
                          <b>{laneName(lane)}</b>
                          <br />
                          {hm(one.start)}–{hm(one.end)}
                          {claude ? `, ${plural(one.requests, 'request')}, ${money(one.cost)}` : ` · ${lane.kind}, no cost on this meter`}
                        </>,
                      )}
                    />
                  )
                })}
              <text x={LABELS + plot + 14} y={mid + 4.5} className="lane-suf">
                {claude
                  ? `${activeLabel(active)} active here · ${money(lane.cost)} today${lane.agents ? ` · ${plural(lane.agents, 'agent')}` : ''}`
                  : `${lane.kind} · ${activeLabel(active)} active`}
                {lane.live ? ' · live' : ''}
              </text>
            </g>
          )
        })}
      </svg>
      {lanes.length > shown.length ? (
        <div className="foot">{lanes.length - shown.length} more in this block; the timeline has every lane.</div>
      ) : null}
      {layer}
    </div>
  )
}

/** one session's stretches across the block, with the cost of each where there is room to say it */
export function MiniLane({
  segments,
  from,
  to,
  now,
  color,
}: {
  segments: Lane['segments']
  from: number
  to: number
  now: number | null
  color: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box, 280)
  const { bind, layer } = useTip()
  const plot = width - 12
  const x = (t: number) => 6 + ((Math.min(Math.max(t, from), to) - from) / (to - from)) * plot
  const inside = segments.filter((one) => one.end > from && one.start < to)
  let lastLabel = -1e9
  return (
    <div className="chart mini" ref={box}>
      <div className="foot mini-cap">
        when it worked, across the block {hm(from)}–{hm(to)}
      </div>
      <svg width={width} height={60}>
        {ticks(from, to, 3600).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={14} y2={42} className="grid" />
            <text x={x(t)} y={56} textAnchor="middle" className="tk">
              {hm(t)}
            </text>
          </g>
        ))}
        <line x1={6} x2={6 + plot} y1={28} y2={28} className="lane-rule" />
        {inside.map((one) => {
          const { agents, cost, requests } = one
          const thick = agents > 0 ? 18 : 10
          const left = x(one.start)
          const label = left - lastLabel > 52
          if (label) lastLabel = left
          return (
            <g key={one.start}>
              <rect
                x={left}
                y={28 - thick / 2}
                width={Math.max(3, x(one.end) - left)}
                height={thick}
                rx={2}
                fill={color}
                {...bind(
                  <>
                    <b>
                      {hm(one.start)}–{hm(one.end)}
                    </b>
                    <br />
                    {plural(requests, 'request')}
                    {`, ${money(cost)}`}
                    {agents ? `, ${plural(agents, 'subagent')}` : ''}
                  </>,
                )}
              />
              {label ? (
                <text x={left} y={28 - thick / 2 - 4} className="lbl">
                  {money(cost)}
                  {one.start < from ? ` since ${hm(one.start)}` : ''}
                </text>
              ) : null}
            </g>
          )
        })}
        {now !== null && now < to ? <line x1={x(now)} x2={x(now)} y1={10} y2={46} className="now" /> : null}
      </svg>
      {layer}
    </div>
  )
}
