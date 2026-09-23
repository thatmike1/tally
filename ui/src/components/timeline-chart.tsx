// the meter chart and the block strip, both on the timeline's one time axis.
// the chart draws the 5-hour sawtooth with weekly, Fable and Codex as thin
// companion lines; the strip draws one tile per 5-hour block and a click on a
// tile reads that block.
import type { BlockSummary, CodexWindow, RangeLanes, State, WeekSummary } from '../api'
import { hm, money, rate } from '../format'
import { HOUR, MIN, shortDay, type Span, type Tick, type Zoom } from './timeline-util'
import type { PlotHandlers } from './timeline-pointer'

export const CHART_HEIGHT = 330
const TOP = 34
const BOTTOM = 26

type MeterPoint = RangeLanes['meter'][number]

/** x of `t` on a track `width` pixels wide showing `view` */
export function xOf(t: number, view: Span, width: number): number {
  return ((t - view.from) / (view.to - view.from)) * width
}

function path(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

/** consecutive points split where `breaks` says the line must not join them */
function runs<T>(items: T[], breaks: (previous: T, next: T) => boolean): T[][] {
  const out: T[][] = []
  let current: T[] = []
  for (const item of items) {
    const previous = current.at(-1)
    if (previous !== undefined && breaks(previous, item)) {
      out.push(current)
      current = []
    }
    current.push(item)
  }
  if (current.length) out.push(current)
  return out
}

interface Label {
  x: number
  anchor: 'start' | 'end'
  text: string
  cls: string
  /** lower wins a collision */
  rank: number
}

/** labels along the chart's top edge, the lower-ranked dropped where two would overlap */
function placeLabels(candidates: Label[], width: number): Label[] {
  const placed: { from: number; to: number; label: Label }[] = []
  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
    const length = candidate.text.length * 6.7
    // a label that would run off the right edge sits on the other side of its line
    const label = candidate.anchor === 'start' && candidate.x + length > width ? { ...candidate, anchor: 'end' as const, x: candidate.x - 10 } : candidate
    const from = label.anchor === 'end' ? label.x - length : label.x
    const to = from + length
    if (from < -2 || to > width + 4) continue
    if (placed.some((p) => from < p.to + 10 && to > p.from - 10)) continue
    placed.push({ from, to, label })
  }
  return placed.map((p) => p.label)
}

export interface ChartProps {
  view: Span
  width: number
  zoom: Zoom
  now: number
  ticks: Tick[]
  meter: MeterPoint[]
  state: State
  blocks: BlockSummary[]
  weeks: WeekSummary[]
  codexWindows: CodexWindow[]
  scopedModel: string | null
  sel: Span
  brush: Span | null
  hoverT: number | null
  handlers: PlotHandlers
}

/** the 5-hour reading at `t`: the last sample at or before it inside the same block, at most 20 minutes old */
export function readingAt(meter: MeterPoint[], t: number, blocks: BlockSummary[]): MeterPoint | null {
  const block = blocks.find((b) => t >= b.start && t < b.resetKey)
  let found: MeterPoint | null = null
  for (const point of meter) {
    if (point.t > t) break
    found = point
  }
  if (!found || t - found.t > 20 * MIN) return null
  if (block && found.resetKey !== block.resetKey) return null
  return found
}

export function Chart(props: ChartProps) {
  const { view, width, zoom, now, meter, state, sel, brush, hoverT } = props
  const height = CHART_HEIGHT
  const plot = height - TOP - BOTTOM
  const x = (t: number) => xOf(t, view, width)
  const y = (pct: number) => TOP + plot * (1 - pct / 100)
  const inView = (from: number, to: number) => to >= view.from && from <= view.to
  const visibleBlocks = props.blocks.filter((b) => inView(b.start, b.resetKey))
  const current = state.block && !state.fiveHour?.ended ? state.block : null

  // the 5-hour sawtooth, one run per block, broken where the sampler slept
  const fiveRuns = runs(meter, (a, b) => a.resetKey !== b.resetKey || b.t - a.t > 20 * MIN)
  const weeklyRuns = runs(
    meter.filter((p) => p.weeklyPct !== null),
    (a, b) => b.t - a.t > HOUR || (b.weeklyPct ?? 0) < (a.weeklyPct ?? 0) - 5,
  )
  const scopedRuns = runs(
    meter.filter((p) => p.scopedPct !== null),
    (a, b) => b.t - a.t > HOUR || (b.scopedPct ?? 0) < (a.scopedPct ?? 0) - 5,
  )
  const codexHistory = state.codex.history ?? []
  const codexRuns = runs(codexHistory, (_, b) => b.afterGap)
  const pace = state.codex.pace?.path ?? null

  // line-end labels at now, pushed apart so they never overlap
  const ends: { pct: number; cls: string; text: string; y: number }[] = []
  if (state.fiveHour && zoom !== 'day') ends.push({ pct: state.fiveHour.pct, cls: 'five', text: `5-hour ${state.fiveHour.pct}`, y: 0 })
  if (state.weekly) ends.push({ pct: state.weekly.pct, cls: 'wk', text: `weekly ${state.weekly.pct}`, y: 0 })
  if (state.fable) ends.push({ pct: state.fable.pct, cls: 'fb', text: `${state.fable.model} ${state.fable.pct}`, y: 0 })
  if (state.codex.usedPercent !== null && state.codex.usedPercent !== undefined)
    ends.push({ pct: state.codex.usedPercent, cls: 'cx', text: `Codex ${state.codex.usedPercent}`, y: 0 })
  ends.sort((a, b) => b.pct - a.pct)
  let lastY = -99
  for (const end of ends) {
    end.y = Math.max(y(end.pct) + 4, lastY + 15)
    lastY = end.y
  }

  const nowX = x(now)
  // the history's window edges and the live reset can differ by a minute; one line each
  const weeklyResets: number[] = []
  for (const t of [...props.weeks.flatMap((w) => [w.start, w.resetsAt]), ...(state.weekly?.resetsAt ? [state.weekly.resetsAt] : [])]) {
    if (!weeklyResets.some((seen) => Math.abs(seen - t) < 5 * MIN)) weeklyResets.push(t)
  }
  const projection = current?.projection

  // block edges in day zoom: where one block ends and the next opens is one reset
  const edges = new Map<number, { opened: boolean; ended: boolean; current: boolean }>()
  if (zoom === 'day') {
    for (const b of visibleBlocks) {
      const open = edges.get(b.start) ?? { opened: false, ended: false, current: false }
      edges.set(b.start, { ...open, opened: true })
      const end = edges.get(b.resetKey) ?? { opened: false, ended: false, current: false }
      edges.set(b.resetKey, { ...end, ended: true, current: end.current || !b.ended })
    }
  }
  const boundaries = [...edges.entries()]
    .filter(([t]) => t > view.from + 5 * MIN && t < view.to)
    .map(([t, edge]) => ({ t, strong: edge.ended, edge }))
  const labels = placeLabels(
    [
      ...(nowX >= 0 && nowX <= width ? [{ x: nowX - 5, anchor: 'end' as const, text: `now ${hm(now)}`, cls: 'tl-lab-now', rank: 0 }] : []),
      ...boundaries.map((b) => ({
        x: x(b.t) + 5,
        anchor: 'start' as const,
        text: b.edge.current ? `reset ${hm(b.t)}` : b.edge.ended && b.edge.opened ? `reset ${hm(b.t)}` : b.edge.ended ? `block ended ${hm(b.t)}` : `block opened ${hm(b.t)}`,
        cls: b.edge.current ? 'tl-lab' : 'tl-lab-m',
        rank: b.edge.current ? 1 : 3,
      })),
      ...weeklyResets
        .filter((t) => inView(t, t))
        .map((t) => ({
          x: x(t) + (x(t) > width - 220 ? -5 : 5),
          anchor: x(t) > width - 220 ? ('end' as const) : ('start' as const),
          text: `weekly reset ${shortDay(t)} ${hm(t)}`,
          cls: 'tl-lab-m',
          rank: 2,
        })),
    ],
    width,
  )
  const last = meter.at(-1)

  return (
    <svg
      className="tl-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      {...props.handlers}
      role="img"
      aria-label="the 5-hour meter with weekly, Fable and Codex over the window shown"
    >
      <defs>
        <clipPath id="tl-clip">
          <rect x="0" y="0" width={width} height={height} />
        </clipPath>
      </defs>
      <g clipPath="url(#tl-clip)">
        {zoom === 'day'
          ? visibleBlocks.map((b) => (
              <rect
                key={b.resetKey}
                x={x(b.start)}
                y={TOP}
                width={Math.max(0, x(b.resetKey) - x(b.start))}
                height={plot}
                className={b.ended ? 'tl-band' : 'tl-band tl-band-now'}
              />
            ))
          : null}
        {[0, 25, 50, 75, 100].map((g) => (
          <line key={g} x1={0} x2={width} y1={y(g)} y2={y(g)} className={g ? 'tl-grid tl-grid-dash' : 'tl-grid'} />
        ))}
        {props.ticks.map((t) => (
          <line key={t.t} x1={x(t.t)} x2={x(t.t)} y1={TOP} y2={TOP + plot} className={t.major ? 'tl-grid' : 'tl-grid tl-grid-soft'} />
        ))}
        {weeklyResets
          .filter((t) => inView(t, t))
          .map((t) => (
            <line key={`w${t}`} x1={x(t)} x2={x(t)} y1={TOP - 8} y2={TOP + plot} className="tl-weekreset" />
          ))}
        <rect x={x(sel.from)} y={TOP} width={Math.max(2, x(sel.to) - x(sel.from))} height={plot} className="tl-sel" />
        <line x1={x(sel.from)} x2={x(sel.from)} y1={TOP} y2={TOP + plot} className="tl-sel-edge" />
        <line x1={x(sel.to)} x2={x(sel.to)} y1={TOP} y2={TOP + plot} className="tl-sel-edge" />
        {fiveRuns.map((run) => {
          const points = run.map((p) => [x(p.t), y(p.pct)] as [number, number])
          const first = points[0]!
          const end = points.at(-1)!
          return (
            <g key={`f${run[0]!.t}`}>
              <path d={`${path(points)}L${end[0]},${y(0)}L${first[0]},${y(0)}Z`} className="tl-five-area" />
              <path d={path(points)} className={zoom === 'since' ? 'tl-five tl-five-thin' : 'tl-five'} />
            </g>
          )
        })}
        {weeklyRuns.map((run) => (
          <path key={`wk${run[0]!.t}`} d={path(run.map((p) => [x(p.t), y(p.weeklyPct!)]))} className="tl-comp tl-wk" />
        ))}
        {scopedRuns.map((run) => (
          <path key={`fb${run[0]!.t}`} d={path(run.map((p) => [x(p.t), y(p.scopedPct!)]))} className="tl-comp tl-fb" />
        ))}
        {props.codexWindows
          .filter((w) => !w.partial && inView(w.from, w.to) && w.to > w.from)
          .map((w) => (
            <path key={`cxw${w.resetsAt}`} d={path([[x(w.from), y(w.startPct)], [x(w.to), y(w.endPct)]])} className="tl-comp tl-cx tl-dotted" />
          ))}
        {codexRuns.map((run) => (
          <path key={`cx${run[0]!.t}`} d={path(run.map((p) => [x(p.t), y(p.pct)]))} className="tl-comp tl-cx" />
        ))}
        {codexRuns.slice(1).map((run, i) => {
          const before = codexRuns[i]!.at(-1)!
          return (
            <path key={`cxg${run[0]!.t}`} d={path([[x(before.t), y(before.pct)], [x(run[0]!.t), y(run[0]!.pct)]])} className="tl-comp tl-cx tl-dotted" />
          )
        })}
        {pace ? <path d={path(pace.map((p) => [x(p.t), y(p.pct)]))} className="tl-comp tl-cx tl-proj" /> : null}
        {zoom === 'day'
          ? boundaries.map((b) => (
              <line key={`b${b.t}`} x1={x(b.t)} x2={x(b.t)} y1={TOP - 8} y2={TOP + plot} className={b.strong ? 'tl-reset' : 'tl-open'} />
            ))
          : null}
        {labels.map((label) => (
          <text key={`${label.cls}${label.x}`} x={label.x} y={TOP - 13} textAnchor={label.anchor} className={label.cls}>
            {label.text}
          </text>
        ))}
        {current && projection?.ready && last && last.resetKey === Math.round(current.resetsAt / 60) * 60
          ? (() => {
              const endT = projection.hitsHundredAt ?? current.resetsAt
              const endPct = projection.hitsHundredAt ? 100 : projection.pctAtReset
              return (
                <g>
                  <path d={path([[x(current.to), y(current.endPct)], [x(endT), y(endPct)]])} className="tl-five-proj" />
                  <circle cx={x(endT)} cy={y(endPct)} r={3.5} className="tl-proj-dot" />
                  {zoom === 'day' ? (
                    <text x={x(endT) + 8} y={y(endPct) + 4} className="tl-lab-five">
                      {projection.hitsHundredAt ? `100% at ${hm(endT)}` : `≈ ${Math.round(endPct)}% at reset`}
                    </text>
                  ) : null}
                </g>
              )
            })()
          : null}
        {state.lastLooked && zoom === 'day' && inView(state.lastLooked, state.lastLooked) && now - state.lastLooked > 5 * MIN ? (
          <g>
            <line x1={x(state.lastLooked)} x2={x(state.lastLooked)} y1={TOP} y2={TOP + plot} className="tl-looked" />
            <text x={x(state.lastLooked) + 4} y={TOP + 13} className="tl-lab-m">
              last looked {hm(state.lastLooked)}
            </text>
          </g>
        ) : null}
        {nowX >= 0 && nowX <= width ? (
          <g>
            <line x1={nowX} x2={nowX} y1={TOP - 8} y2={TOP + plot} className="tl-now" />
            {ends.map((end) => (
              <text key={end.cls} x={nowX + 8} y={end.y} className={`tl-end tl-end-${end.cls}`}>
                {end.text}
              </text>
            ))}
          </g>
        ) : null}
        {[25, 50, 75, 100].map((g) => (
          <text key={g} x={width - 4} y={y(g) + 14} textAnchor="end" className="tl-axis">
            {g}%
          </text>
        ))}
        {props.ticks.map((t) => (
          <text key={t.t} x={x(t.t) + 3} y={TOP + plot + 17} className={t.major ? 'tl-axis tl-axis-major' : 'tl-axis'}>
            {t.label}
          </text>
        ))}
        {brush ? <rect x={x(brush.from)} y={TOP} width={Math.max(1, x(brush.to) - x(brush.from))} height={plot} className="tl-brush" /> : null}
        {hoverT !== null
          ? (() => {
              const reading = readingAt(meter, hoverT, props.blocks)
              return (
                <g>
                  <line x1={x(hoverT)} x2={x(hoverT)} y1={TOP} y2={TOP + plot} className="tl-cross" />
                  {reading ? <circle cx={x(hoverT)} cy={y(reading.pct)} r={4} className="tl-cross-dot" /> : null}
                </g>
              )
            })()
          : null}
      </g>
    </svg>
  )
}

export interface StripProps {
  view: Span
  width: number
  zoom: Zoom
  now: number
  blocks: BlockSummary[]
  /** the reset key of the block being read, when the range is exactly one block */
  selectedKey: number | null
  currentKey: number | null
  onPick: (block: BlockSummary) => void
  onHover: (block: BlockSummary | null, event: React.PointerEvent) => void
}

export const STRIP_HEIGHT = 46

/** what a block tile says when there is room: time, where it ended, cost and cost per point */
function tileText(b: BlockSummary, current: boolean, room: number): string {
  const when = `${hm(b.start)}–${hm(b.resetKey)}`
  const where = current ? `${b.endPct}% so far` : `ended ${b.endPct}%`
  const full = `${when} · ${where} · ${money(b.usage.cost)} list${b.dollarsPerPercent !== null ? ` · ${rate(b.dollarsPerPercent)} per point` : ''}`
  if (room > full.length * 6.6) return full
  const mid = `${when} · ${where}`
  if (room > mid.length * 6.6) return mid
  const small = `${b.endPct}%`
  return room > 30 ? small : ''
}

/** one tile per 5-hour block on the chart's axis; the tile's height in wide zooms is where it ended */
export function BlockStrip(props: StripProps) {
  const { view, width, zoom } = props
  const x = (t: number) => xOf(t, view, width)
  const visible = props.blocks.filter((b) => b.resetKey >= view.from && b.start <= view.to)
  const height = STRIP_HEIGHT
  return (
    <svg className="tl-strip" width={width} height={height} viewBox={`0 0 ${width} ${height}`} onPointerLeave={(e) => props.onHover(null, e)}>
      {visible.map((b) => {
        const x0 = Math.max(0, x(b.start))
        const x1 = Math.min(width, x(b.resetKey))
        const w = Math.max(1.5, x1 - x0 - (zoom === 'since' ? 1 : 3))
        const current = b.resetKey === props.currentKey
        const on = b.resetKey === props.selectedKey
        const cls = `tl-tile${current ? ' tl-tile-now' : ''}${on ? ' tl-tile-on' : ''}${b.measured || current ? '' : ' tl-tile-unmeasured'}`
        const pick = () => props.onPick(b)
        const hover = (e: React.PointerEvent) => props.onHover(b, e)
        if (zoom === 'day') {
          return (
            <g key={b.resetKey} className={cls} onClick={pick} onPointerMove={hover}>
              <rect x={x0} y={4} width={w} height={height - 8} rx={4} className="tl-tile-bg" />
              <text x={x0 + 10} y={height / 2 + 5} className="tl-tile-text">
                {tileText(b, current, w - 20)}
              </text>
            </g>
          )
        }
        const top = 16 + (height - 20) * (1 - Math.min(100, b.endPct) / 100)
        return (
          <g key={b.resetKey} className={cls} onClick={pick} onPointerMove={hover}>
            <rect x={x0} y={2} width={w} height={height - 4} className="tl-tile-hit" />
            <rect x={x0} y={top} width={w} height={height - 4 - top} rx={1.5} className="tl-tile-bar" />
            {zoom === 'week' && w > 26 ? (
              <text x={x0 + w / 2} y={top - 3} textAnchor="middle" className="tl-tile-num">
                {b.endPct}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
