import { useEffect, useRef, useState } from 'react'
import { agentsview, errorLine, fetchSession, type AgentLane, type RequestPoint, type SessionDetail } from '../api'
import { dayDate, duration, hm, money, projectName, tokens } from '../format'
import { useWidth } from './charts'

/** credits, the Codex unit: whole numbers read fine, a fraction only under ten */
function credits(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

/**
 * one session, one zoom level in from the lanes: the parent transcript on top,
 * one row per subagent under it, every request a mark on the shared time axis.
 *
 * the visual language is the lanes' — `--lane`, brightness by cost, the same row
 * rhythm — because this is the same picture with the fan-out pulled apart.
 */
const LABELS = 190
const RIGHT = 124
const TOP = 26
const ROW = 34
const BAND = 14
const AXIS = 20
const MARK = 3

export function Session({ id, at }: { id: string; at?: number | undefined }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    fetchSession(id, at)
      .then((answer) => {
        if (alive) setDetail(answer)
      })
      .catch((problem: unknown) => {
        if (alive) setError(errorLine(problem))
      })
    return () => {
      alive = false
    }
  }, [id, at])

  if (error) {
    return (
      <>
        <p className="warn">{error}</p>
        <p className="more">
          <a href="#/">back to today</a>
        </p>
      </>
    )
  }
  if (!detail) return <p className="loading">reading the transcript…</p>

  const lanes = [detail.parent, ...[...detail.subagents].sort((a, b) => a.start - b.start)]
  const amount = detail.unit === 'credits' ? credits : money
  return (
    <>
      <div className="sd-head">
        <h1 className="sd-title">{detail.title ?? detail.sessionId.slice(0, 8)}</h1>
        <div className="sd-meta">
          {projectName(detail.project)} · {dayDate(detail.start)} {hm(detail.start)}–{hm(detail.end)} ·{' '}
          {duration(detail.end - detail.start)}
          {at !== undefined ? ` · frozen at ${dayDate(at)} ${hm(at)}` : null}
          {detail.live ? (
            <>
              {' · '}
              <b className="lv">live</b>
            </>
          ) : null}
        </div>
        <div className="sd-nums">
          <span>
            <b>{amount(detail.cost)}</b>{detail.unit === 'credits' ? 'credits' : 'list price'}
          </span>
          <span>
            <b>{tokens(detail.tokens)}</b>tokens
          </span>
          <span>
            <b>{detail.requests}</b>requests
          </span>
          <span>
            <b>{detail.subagents.length}</b>subagent{detail.subagents.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="sd-links">
          <a href={agentsview(detail.sessionId)}>read the transcript in AgentsView ↗</a>
          <a href="#/">back to today</a>
        </div>
      </div>
      <Rows lanes={lanes} amount={amount} />
      <p className="caveat">
        Every mark is one request at the moment it answered, sized and shaded by its cost; the label over a
        run names the model family and the full model id is on hover. A subagent row is its own transcript file, so a
        fan-out reads as parallel rows rather than one thick bar.
      </p>
    </>
  )
}

/** a nice tick interval for the span, in seconds */
function tickStep(span: number): number {
  for (const step of [300, 900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600]) {
    if (span / step <= 8) return step
  }
  return 24 * 3600
}

function totalOf(request: RequestPoint): number {
  const t = request.tokens
  return t.in + t.cw1h + t.cw5m + t.cr + t.out
}

/** the server's label (the subagent's file name) when it has one, a position otherwise */
function laneName(lane: AgentLane, index: number): string {
  const label = (lane.label ?? '').trim()
  if (label) return label
  return lane.agent ? `agent ${index}` : 'main'
}

function Rows({ lanes, amount }: { lanes: AgentLane[]; amount: (value: number) => string }) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box, 480)
  const withRequests = lanes.filter((lane) => lane.requests.length > 0)
  const times = withRequests.flatMap((lane) => lane.requests.map((request) => request.t))
  if (!times.length) return <p className="more">no priced requests in this session's transcripts.</p>
  const start = Math.min(...times)
  const end = Math.max(...times)
  const span = Math.max(60, end - start)
  // a session that answered in one burst still needs room on both sides of its marks
  const pad = span * 0.02
  const x = (t: number) => LABELS + ((t - (start - pad)) / (span + pad * 2)) * (width - LABELS - RIGHT)
  const maxCost = Math.max(0.0001, ...withRequests.flatMap((lane) => lane.requests.map((request) => request.cost)))
  const height = TOP + lanes.length * ROW + AXIS

  const step = tickStep(span)
  const ticks: number[] = []
  for (let t = Math.ceil((start - pad) / step) * step; t <= end + pad; t += step) ticks.push(t)

  return (
    <div ref={box}>
      <h2>this session on the clock</h2>
      <svg width={width} height={height} role="img" aria-label="every request of this session on a time axis">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={TOP + lanes.length * ROW} className="grid" />
            <text x={x(t)} y={height - 6} className="tk" textAnchor="middle">
              {hm(t)}
            </text>
          </g>
        ))}
        {lanes.map((lane, index) => {
          const top = TOP + index * ROW
          const mid = top + BAND / 2
          const name = laneName(lane, index)
          const last = lane.requests.at(-1)
          // the right gutter is outside the time axis, so a row's cost sits after its
          // last mark and never on top of one
          const costAt = last ? Math.min(x(last.t) + 10, width - RIGHT + 8) : LABELS + 10
          return (
            <g key={lane.file}>
              <line x1={LABELS} x2={width - RIGHT} y1={top + BAND / 2} y2={top + BAND / 2} className="sd-base" />
              <text x={LABELS - 12} y={mid + 4} className="sd-row" textAnchor="end">
                {name}
                <title>{lane.file}</title>
              </text>
              {lane.requests.map((request) => {
                const weight = Math.sqrt(Math.min(1, request.cost / maxCost))
                const size = 4 + 10 * weight
                return (
                  <rect
                    key={`${request.t}-${request.model}`}
                    className="sd-mk"
                    x={x(request.t) - MARK / 2}
                    y={mid - size / 2}
                    width={MARK}
                    height={size}
                    rx={1.5}
                    opacity={0.35 + 0.55 * weight}
                  >
                    <title>
                      {`${hm(request.t)} · ${request.model} · ${amount(request.cost)}${
                        request.priced ? '' : ' (no price row)'
                      } · ${tokens(totalOf(request))} tokens`}
                    </title>
                  </rect>
                )
              })}
              <FamilyLabels requests={lane.requests} x={x} y={top - 3} />
              {lane.requests.length ? (
                <text x={costAt} y={mid + 4} className="sd-cost">
                  {amount(lane.cost)} · {lane.requests.length} req
                </text>
              ) : (
                <text x={LABELS + 10} y={mid + 4} className="sd-cost">
                  no requests in this file
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/**
 * the model per request, labelled where it changes and where there is room for
 * the word: a label over every mark would be a wall, and the family only ever
 * changes a handful of times inside one row.
 */
function FamilyLabels({ requests, x, y }: { requests: RequestPoint[]; x: (t: number) => number; y: number }) {
  const labels: { at: number; text: string }[] = []
  let previous: string | null = null
  let right = -Infinity
  for (const request of requests) {
    if (request.family === previous) continue
    previous = request.family
    const at = x(request.t)
    if (at < right) continue
    labels.push({ at, text: request.family })
    right = at + request.family.length * 6 + 10
  }
  return (
    <>
      {labels.map((label) => (
        <text key={`${label.at}-${label.text}`} x={label.at} y={y} className="sd-fam">
          {label.text}
        </text>
      ))}
    </>
  )
}
