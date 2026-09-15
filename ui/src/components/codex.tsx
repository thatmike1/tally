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
  if (!pace.ready) {
    return (
      <div className="cx-v">
        <b className="n">no pace yet</b>
        <span>{pace.reason}</span>
      </div>
    )
  }
  const basis = pace.provisional
    ? `every workday uses what today has so far (${pct(pace.typicalDay ?? 0)})`
    : `every workday uses the median of ${pace.measuredDays} full workday${pace.measuredDays === 1 ? '' : 's'} (${pct(pace.typicalDay ?? 0)})`
  return (
    <div className="cx-v">
      <b className={pace.hitsHundredAt !== null ? 'over' : ''}>{pace.phrase.replace(/, provisional$/, '')}</b>
      <span>
        {pace.provisional ? 'provisional · ' : ''}if {basis} until the reset, weekends free
      </span>
    </div>
  )
}

/** the window from open to reset: readings, and the expected path to it with weekends flat */
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
  const projection = pace?.ready && pace.path.length > 1 ? pace.path.map((point) => `${x(point.t)},${y(point.pct)}`).join(' ') : null

  return (
    <div className="cx-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Codex weekly meter over the week">
        {[1, 2, 3, 4, 5, 6].map((day) => (
          <line key={day} className="grid" x1={(W / 7) * day} x2={(W / 7) * day} y1={0} y2={H} />
        ))}
        {bridges.map((points) => (
          <polyline key={points} className="cx-gap" points={points} />
        ))}
        {runs.map((points) => (
          // a lone reading repeats its point so the round cap draws it as a dot
          <polyline key={points[0]} className="cx-line" points={(points.length === 1 ? [points[0], points[0]] : points).join(' ')} />
        ))}
        {projection ? <polyline className="cx-proj" points={projection} /> : null}
      </svg>
      <div className="stripcap">
        the week since {dayClock(windowStart)}{projection ? ' · dashed is the expected path, flat on weekends' : ''}
        {history.some((point) => point.afterGap) ? ' · dotted where the reader missed a stretch' : ''}
      </div>
    </div>
  )
}
