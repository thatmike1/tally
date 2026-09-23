// the session lanes under the chart: one row per session grouped by project,
// its share of the range big on the left, its activity on the shared axis in
// the middle, and its numbers on the right in the today ledger's styling.
import { useState } from 'react'
import { agentsview, type Lane, type RangeSplit, type SessionRow, type State } from '../api'
import { duration, hm, labelOn, money, projectName, tokens } from '../format'
import { sessionHref } from '../route'
import { xOf } from './timeline-chart'
import type { PlotHandlers } from './timeline-pointer'
import { activeIn, approxPoints, modelName, reachIn, realModels, share, type Span, type Tick, type Zoom } from './timeline-util'

export type CodexThread = NonNullable<State['codex']['split']>['threads'][number]

export interface RowModel {
  id: string
  /** `claude`, or T3's provider name: `codex`, `antigravity`, `opencode` */
  kind: string
  title: string
  /** the first thing typed into the session, when a T3 title is shown instead */
  firstLine: string | null
  project: string
  lane: Lane | null
  five: SessionRow | null
  weekly: SessionRow | null
  color: string
  /** seconds of lane activity inside the range */
  active: number
  reach: Span | null
  /** did anything in this session land in the range */
  touched: boolean
  codex: CodexThread | null
}

export interface Group {
  project: string
  rows: RowModel[]
  cost: number
  share: number
}

/** Claude's encoded project dir for a path: every non-alphanumeric character becomes a dash */
function encoded(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function spans(lane: Lane | null): Span[] {
  return lane ? lane.segments.map((s) => ({ from: s.start, to: s.end })) : []
}

/**
 * the rows for a range: every session the split saw, every lane on screen, and
 * for a Codex thread its part of this Codex week. grouped by project, the
 * groups ranked by how much of the range they ate.
 */
export function buildGroups(lanes: Lane[], split: RangeSplit | null, range: Span, codex: CodexThread[]): Group[] {
  const byLane = new Map(lanes.map((lane) => [lane.id, lane]))
  const paths = new Map(lanes.map((lane) => [encoded(lane.project), lane.project]))
  const weekly = new Map((split?.weekly.sessions ?? []).map((row) => [row.sessionId, row]))
  const codexById = new Map(codex.map((thread) => [thread.id, thread]))
  // a lane carries T3's thread id and the Codex split its own; the T3 title is the only shared key
  const codexByTitle = new Map(codex.filter((thread) => thread.via === 't3').map((thread) => [thread.title, thread]))
  const rows: RowModel[] = []
  const seen = new Set<string>()

  for (const five of split?.fiveHour.sessions ?? []) {
    const lane = byLane.get(five.sessionId) ?? null
    const segments = spans(lane)
    const title = five.shortTitle ?? lane?.shortTitle ?? five.title ?? lane?.title ?? five.sessionId.slice(0, 8)
    const raw = five.title ?? lane?.title ?? null
    rows.push({
      id: five.sessionId,
      kind: 'claude',
      title,
      firstLine: raw && raw !== title ? raw : null,
      project: projectName(lane?.project ?? paths.get(five.project) ?? five.project),
      lane,
      five,
      weekly: weekly.get(five.sessionId) ?? null,
      color: five.color,
      active: activeIn(segments, range),
      reach: reachIn(segments, range) ?? { from: Math.max(five.start, range.from), to: Math.min(five.end, range.to) },
      touched: true,
      codex: null,
    })
    seen.add(five.sessionId)
  }
  for (const lane of lanes) {
    if (seen.has(lane.id)) continue
    const segments = spans(lane)
    const reach = reachIn(segments, range)
    const claude = lane.kind === 'claude'
    const title = lane.shortTitle ?? lane.title
    rows.push({
      id: lane.id,
      kind: lane.kind,
      title,
      firstLine: lane.shortTitle && lane.title !== lane.shortTitle ? lane.title : null,
      project: projectName(lane.project),
      lane,
      five: null,
      weekly: null,
      color: claude ? 'var(--tl-idle)' : 'var(--tl-cx)',
      active: activeIn(segments, range),
      reach,
      // a Claude session with no request in the range is idle, whatever its lane shows
      touched: !claude && reach !== null,
      codex: claude ? null : (codexById.get(lane.id) ?? codexByTitle.get(lane.title) ?? null),
    })
  }

  const groups = new Map<string, Group>()
  for (const row of rows) {
    let group = groups.get(row.project)
    if (!group) {
      group = { project: row.project, rows: [], cost: 0, share: 0 }
      groups.set(row.project, group)
    }
    group.rows.push(row)
    group.cost += row.five?.cost ?? 0
    group.share += row.five?.share ?? 0
  }
  const rank = (row: RowModel) => (row.five ? 2 + row.five.share : row.touched ? 1 + row.active / 1e7 : (row.lane?.cost ?? 0) / 1e6)
  for (const group of groups.values()) group.rows.sort((a, b) => rank(b) - rank(a))
  const touched = (group: Group) => group.rows.filter((row) => row.touched).length
  return [...groups.values()].sort((a, b) => b.share - a.share || touched(b) - touched(a) || (b.rows[0]?.lane?.cost ?? 0) - (a.rows[0]?.lane?.cost ?? 0))
}

/** `opus 5.5`, `opus 5.5 + fable 5.1` */
export function modelsLine(row: SessionRow): string {
  const models = realModels(row.models)
  if (!models.length) return 'model not recorded'
  return models
    .slice(0, 2)
    .map((m) => modelName(m.model))
    .join(' + ')
    .concat(models.length > 2 ? ` +${models.length - 2}` : '')
}

/** `high`, `high, some xhigh`; null when no request recorded one */
export function effortLine(row: SessionRow): string | null {
  const known = row.effort.filter((e) => e.effort !== null)
  if (!known.length) return null
  const [top, next] = known
  if (!next || next.requests < row.requests * 0.1) return `${top!.effort}`
  return `${top!.effort}, some ${next.effort}`
}

/** the column heads over the rail; the share column is the big number on the left */
export function RailHead() {
  return (
    <div className="tl-rail tl-rail-head">
      <span>
        of weekly
        <small>~points</small>
      </span>
      <span>
        of Fable
        <small>~points</small>
      </span>
      <span>
        tokens
        <small>requests</small>
      </span>
      <span>
        list cost
        <small>usd</small>
      </span>
      <span>
        active
        <small>in the range</small>
      </span>
    </div>
  )
}

function Num({ main, sub, faint }: { main: string; sub: string; faint?: boolean }) {
  return (
    <span className={faint ? 'tl-n tl-n-faint' : 'tl-n'}>
      <span className="tl-n-main">{main}</span>
      <span className="tl-n-sub">{sub}</span>
    </span>
  )
}

function Rail({ row, split }: { row: RowModel; split: RangeSplit | null }) {
  if (row.five) {
    const five = row.five
    const weeklyMeasured = split?.weekly.delta !== null && split?.weekly.delta !== undefined
    const fableHere = five.fableShare !== null && five.fableShare > 0
    return (
      <div className="tl-rail">
        {row.weekly ? (
          <Num main={share(row.weekly.share)} sub={weeklyMeasured ? `${approxPoints(row.weekly.points)} pts` : 'not measured'} />
        ) : (
          <Num main="0%" sub="" faint />
        )}
        {fableHere ? <Num main={share(five.fableShare!)} sub={`${approxPoints(five.fablePoints)} pts`} /> : <Num main="–" sub="" faint />}
        <Num main={tokens(five.tokens)} sub={`${five.requests} requests`} />
        <Num main={money(five.cost)} sub={five.unpriced ? 'a floor, unpriced model' : 'list price'} />
        <Num main={row.active >= 60 ? duration(row.active) : '<1m'} sub={row.reach ? `${hm(row.reach.from)}–${hm(row.reach.to)}` : ''} />
      </div>
    )
  }
  if (row.kind !== 'claude') {
    const thread = row.codex
    return (
      <div className="tl-rail tl-rail-wide">
        <span className="tl-note">
          {row.touched ? (
            <>
              <b>{row.active >= 60 ? duration(row.active) : '<1m'}</b> active in range
            </>
          ) : (
            'not active in the range'
          )}{' '}
          · no Claude usage
          {thread ? (
            <>
              {' '}
              · <b>{share(thread.share)}</b> of this Codex week · <b>{Math.round(thread.credits)}</b> credits · {approxPoints(thread.points)} pts
            </>
          ) : null}
        </span>
      </div>
    )
  }
  return (
    <div className="tl-rail tl-rail-wide">
      <span className="tl-note tl-faint">no requests in this range</span>
    </div>
  )
}

export interface LaneTrackProps {
  lane: Lane | null
  color: string
  view: Span
  width: number
  zoom: Zoom
  ticks: Tick[]
  sel: Span
  brush: Span | null
  hoverT: number | null
  maxRate: number
  handlers: PlotHandlers
}

export const LANE_HEIGHT = 46

/** cost per second of a segment, the brightness scale */
export function segmentRate(segment: { start: number; end: number; cost: number }): number {
  return segment.cost / Math.max(60, segment.end - segment.start)
}

function LaneTrack(props: LaneTrackProps) {
  const { lane, view, width, sel, brush, hoverT } = props
  const height = LANE_HEIGHT
  const mid = height / 2
  const x = (t: number) => xOf(t, view, width)
  const claude = lane?.kind === 'claude'
  let lastX = -1
  const segments = (lane?.segments ?? [])
    .filter((s) => s.end >= view.from && s.start <= view.to)
    .map((s) => {
      const x0 = x(s.start)
      const x1 = Math.max(x0 + 3, x(s.end))
      lastX = Math.max(lastX, x1)
      const thick = s.agents > 0 ? 24 : 12
      const bright = claude && props.maxRate > 0 ? 0.35 + 0.65 * Math.sqrt(segmentRate(s) / props.maxRate) : 0.6
      const inside = s.end >= sel.from && s.start <= sel.to
      return (
        <rect
          key={s.start}
          x={x0}
          y={mid - thick / 2}
          width={x1 - x0}
          height={thick}
          rx={Math.min(3, thick / 2)}
          fill={props.color}
          opacity={inside ? bright : bright * 0.4}
        />
      )
    })
  const activeTotal = (lane?.segments ?? []).reduce((sum, s) => sum + (s.end - s.start), 0)
  const label =
    lane && props.zoom === 'day'
      ? claude
        ? `${duration(activeTotal)} active · ${lane.agents ? `${lane.agents} agent${lane.agents === 1 ? '' : 's'} · ` : ''}${money(lane.cost)}`
        : `${duration(activeTotal)} active · ${lane.kind}`
      : null
  return (
    <svg className="tl-lane" width={width} height={height} viewBox={`0 0 ${width} ${height}`} {...props.handlers}>
      {props.ticks.map((t) => (
        <line key={t.t} x1={x(t.t)} x2={x(t.t)} y1={0} y2={height} className="tl-lane-grid" />
      ))}
      <rect x={x(sel.from)} y={0} width={Math.max(2, x(sel.to) - x(sel.from))} height={height} className="tl-sel tl-sel-lane" />
      {segments}
      {label && lastX >= 0 && lastX + label.length * 6.4 + 16 < width ? (
        <text x={lastX + 8} y={mid + 4} className="tl-lab-m">
          {label}
        </text>
      ) : null}
      {brush ? <rect x={x(brush.from)} y={0} width={Math.max(1, x(brush.to) - x(brush.from))} height={height} className="tl-brush" /> : null}
      {hoverT !== null ? <line x1={x(hoverT)} x2={x(hoverT)} y1={0} y2={height} className="tl-cross" /> : null}
    </svg>
  )
}

export interface LanesProps {
  groups: Group[]
  split: RangeSplit | null
  state: State
  view: Span
  width: number
  zoom: Zoom
  ticks: Tick[]
  sel: Span
  brush: Span | null
  hoverT: number | null
  hotLane: string | null
  handlers: (laneId: string | null) => PlotHandlers
}

/** a group shows this many rows before the rest fold behind one line */
const GROUP_SHOWN = 12

/** show every idle row up to this many; past it they fold behind one line */
const IDLE_SHOWN = 12

export function Lanes(props: LanesProps) {
  const [showIdle, setShowIdle] = useState(false)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set())
  const idleCount = props.groups.reduce((n, g) => n + g.rows.filter((row) => !row.touched).length, 0)
  const foldIdle = idleCount > IDLE_SHOWN && !showIdle
  const maxRate = Math.max(
    0,
    ...props.groups.flatMap((g) => g.rows.flatMap((row) => (row.lane?.kind === 'claude' ? row.lane.segments.map(segmentRate) : []))),
  )

  const groups = props.groups
    .map((group) => {
      const rows = foldIdle ? group.rows.filter((row) => row.touched) : group.rows
      const open = openGroups.has(group.project)
      const hidden = open || rows.length <= GROUP_SHOWN + 2 ? 0 : rows.length - GROUP_SHOWN
      return { ...group, total: rows.length, hidden, rows: hidden ? rows.slice(0, GROUP_SHOWN) : rows }
    })
    .filter((group) => group.rows.length)
  const toggleGroup = (project: string) =>
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })

  if (!groups.length) {
    return (
      <div className="tl-grid-row tl-empty">
        <div />
        <p>No session ran in this range{foldIdle ? ' ' : '.'}{foldIdle ? <button className="tl-link" onClick={() => setShowIdle(true)}>show the {idleCount} sessions on screen</button> : null}</p>
        <div />
      </div>
    )
  }

  return (
    <div className="tl-lanes">
      {groups.map((group) => (
        <section key={group.project} className="tl-group">
          <div className="tl-grid-row tl-group-head">
            <div>
              <span className="tl-group-name">{group.project}</span>{' '}
              <span className="tl-group-meta">
                {group.total} session{group.total === 1 ? '' : 's'}
                {group.cost > 0 ? ` · ${money(group.cost)} in range` : ''}
              </span>
            </div>
            <div />
            <div />
          </div>
          {group.rows.map((row) => {
            const link = row.kind === 'claude' ? agentsview(props.state.agentsviewUrl, row.id) : null
            const effort = row.five ? effortLine(row.five) : null
            const hot = props.hotLane === row.id
            return (
              <div key={row.id} className={`tl-grid-row tl-row${row.touched ? '' : ' tl-row-idle'}${hot ? ' tl-row-hot' : ''}`}>
                <div className="tl-who">
                  <span className="tl-share">
                    {row.five ? (
                      <>
                        <span className="tl-share-main">{share(row.five.share)}</span>
                        <span className="tl-share-sub">
                          {row.five.points === null ? 'not measured' : `${approxPoints(row.five.points)} pts`}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="tl-share-main tl-faint">–</span>
                        <span className="tl-share-sub">{row.kind === 'claude' ? 'idle' : row.kind}</span>
                      </>
                    )}
                  </span>
                  <span className="tl-chip" style={{ background: row.color }} />
                  <span className="tl-names">
                    <a href={sessionHref(row.id)} className="tl-nick-link">
                      {row.title}
                    </a>
                    <span className="tl-tags">
                      {row.five ? (
                        <>
                          <span className="tl-tag-model">{modelsLine(row.five)}</span>
                          {effort ? <span className="tl-tag-effort">{effort} effort</span> : null}
                          {row.five.subagents ? (
                            <span>
                              {row.five.subagents} subagent{row.five.subagents === 1 ? '' : 's'}
                            </span>
                          ) : null}
                        </>
                      ) : row.kind !== 'claude' ? (
                        <span className="tl-tag-model">
                          {row.kind}
                          {row.codex?.models.length ? ` · ${row.codex.models.map(modelName).join(' + ')}` : ''}
                        </span>
                      ) : (
                        <span>no requests in this range</span>
                      )}
                      {row.five?.live || (!row.five && row.lane?.live) ? <span className="tl-live">live</span> : null}
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" className="tl-transcript">
                          transcript ↗
                        </a>
                      ) : null}
                    </span>
                  </span>
                </div>
                <LaneTrack
                  lane={row.lane}
                  color={row.color}
                  view={props.view}
                  width={props.width}
                  zoom={props.zoom}
                  ticks={props.ticks}
                  sel={props.sel}
                  brush={props.brush}
                  hoverT={props.hoverT}
                  maxRate={maxRate}
                  handlers={props.handlers(row.id)}
                />
                <Rail row={row} split={props.split} />
              </div>
            )
          })}
          {group.hidden || openGroups.has(group.project) ? (
            <div className="tl-grid-row tl-fold">
              <div />
              <button className="tl-link" onClick={() => toggleGroup(group.project)}>
                {group.hidden ? `+ ${group.hidden} more sessions in ${group.project}` : `fold ${group.project} back to its top ${GROUP_SHOWN}`}
              </button>
              <div />
            </div>
          ) : null}
        </section>
      ))}
      {idleCount > IDLE_SHOWN ? (
        <div className="tl-grid-row tl-fold">
          <div />
          <button className="tl-link" onClick={() => setShowIdle((open) => !open)}>
            {showIdle ? `fold the ${idleCount} sessions that did nothing in this range` : `+ ${idleCount} more sessions on screen that did nothing in this range`}
          </button>
          <div />
        </div>
      ) : null}
    </div>
  )
}

/** the stacked share of the range's 5-hour movement, one piece per session, in the lanes' colours */
export function ShareStrip({ rows }: { rows: SessionRow[] }) {
  const shown = rows.filter((row) => row.share > 0)
  return (
    <div className="tl-share-strip">
      {shown.map((row) => (
        <span
          key={row.sessionId}
          style={{ flexBasis: `${(row.share * 100).toFixed(2)}%`, background: row.color, color: labelOn(row.color) }}
        >
          {row.share > 0.07 ? share(row.share) : ''}
        </span>
      ))}
    </div>
  )
}
