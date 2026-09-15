import type { State } from '../api'
import { ago, dayClock, days, pct } from '../format'

type CodexView = State['codex']

/** the chart's own coordinate space; it stretches to the column, strokes stay one pixel */
const W = 1000
const H = 100

/**
 * Codex's weekly allowance, beside the Claude meters rather than inside them:
 * there is no cost model for Codex, so nothing here splits or attributes.
 */
export function Codex({ state }: { state: State }) {
  const codex = state.codex
  if (codex.status === 'unavailable') {
    return (
      <section className="codex quiet">
        <h2>codex · this week</h2>
        <p className="calc">{codex.line.replace(/^Codex · /, '')}</p>
      </section>
    )
  }

  const stale = codex.status === 'stale'
  return (
    <section className="codex">
      <div className="cx-num">
        <h2>codex · this week</h2>
        {stale || codex.usedPercent === null ? '–' : pct(codex.usedPercent)}
        <small>
          {codex.resetsAt === null ? '' : `resets ${dayClock(codex.resetsAt)}, in ${days(codex.resetsAt - state.now)} · `}
          {codex.ageSeconds === null ? 'never read' : `read ${ago(codex.ageSeconds)}`}
        </small>
      </div>
      <Verdict codex={codex} />
      <WeekChart codex={codex} />
    </section>
  )
}

function Verdict({ codex }: { codex: CodexView }) {
  const pace = codex.pace
  if (codex.status === 'stale' || !pace) {
    return (
      <div className="cx-v">
        <b className="over">reading is stale</b>
        <span>the Codex reader has not reported a fresh number, so there is no pace from an old one</span>
      </div>
    )
  }
  const even = `an even week would be at ${pct(pace.evenPct)} by now`
  if (!pace.ready) {
    return (
      <div className="cx-v">
        <b className="n">no pace yet</b>
        <span>
          {pace.reason} · {even}
        </span>
      </div>
    )
  }
  return (
    <div className="cx-v">
      <b className={pace.pctAtReset !== null && pace.pctAtReset >= 100 ? 'over' : ''}>{pace.phrase}</b>
      <span>at this week's average so far · {even}</span>
    </div>
  )
}

/** the window from open to reset: readings, the even-week diagonal, and the projection */
function WeekChart({ codex }: { codex: CodexView }) {
  const { windowStart, resetsAt, history, pace } = codex
  if (windowStart === null || resetsAt === null) return <div />
  const x = (t: number) => ((t - windowStart) / (resetsAt - windowStart)) * W
  const y = (value: number) => H - Math.min(100, Math.max(0, value)) * (H / 100)

  // a gap splits the line; the dotted bridge says the meter moved while nobody read it
  const runs: string[][] = []
  const bridges: string[] = []
  for (const [index, point] of history.entries()) {
    const previous = history[index - 1]
    const at = `${x(point.t)},${y(point.pct)}`
    if (!previous || point.afterGap) {
      if (previous) bridges.push(`${x(previous.t)},${y(previous.pct)} ${at}`)
      runs.push([])
    }
    runs.at(-1)!.push(at)
  }
  const last = history.at(-1)
  const projection =
    last && pace?.ready && pace.pctAtReset !== null && pace.pctAtReset > last.pct
      ? [x(last.t), y(last.pct), x(pace.hitsHundredAt ?? resetsAt), y(pace.pctAtReset)]
      : null

  return (
    <div className="cx-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Codex weekly meter over the week">
        {[1, 2, 3, 4, 5, 6].map((day) => (
          <line key={day} className="grid" x1={(W / 7) * day} x2={(W / 7) * day} y1={0} y2={H} />
        ))}
        <line className="cx-even" x1={0} y1={H} x2={W} y2={0} />
        {bridges.map((points) => (
          <polyline key={points} className="cx-gap" points={points} />
        ))}
        {runs.map((points) => (
          // a lone reading repeats its point so the round cap draws it as a dot
          <polyline key={points[0]} className="cx-line" points={(points.length === 1 ? [points[0], points[0]] : points).join(' ')} />
        ))}
        {projection ? <line className="cx-proj" x1={projection[0]} y1={projection[1]} x2={projection[2]} y2={projection[3]} /> : null}
      </svg>
      <div className="stripcap">
        the week since {dayClock(windowStart)} · dashed diagonal is an even week
        {history.some((point) => point.afterGap) ? ' · dotted where the reader missed a stretch' : ''}
      </div>
    </div>
  )
}
