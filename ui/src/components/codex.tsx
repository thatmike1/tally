import type { State } from '../api'
import { ago, dayClock, days, hm, labelOn, pct } from '../format'

type CodexView = State['codex']

/** the chart's own coordinate space; it stretches to the column, strokes stay one pixel */
const W = 1000
const H = 100

/**
 * Codex's weekly allowance, beside the Claude meters rather than inside them:
 * there is no cost model for Codex, so nothing here splits or attributes.
 */
export function Codex({ state, frozen = false }: { state: State; frozen?: boolean }) {
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
          {/* frozen, the age would be counted from the page's past instant, so say when it was read */}
          {codex.sampledAt !== null && frozen
            ? `sampled ${hm(codex.sampledAt)}`
            : codex.ageSeconds === null
              ? 'never read'
              : `read ${ago(codex.ageSeconds)}`}
        </small>
      </div>
      <Verdict codex={codex} />
      <WeekChart codex={codex} />
    </section>
  )
}

/** rows past this fold into a count */
const THREAD_ROWS = 10

/** `1,240 credits` */
function credits(value: number): string {
  return `${Math.round(value).toLocaleString('en-US')} credits`
}

/** which Codex threads moved the weekly meter, split by credits off the rollout files */
export function CodexThreads({ state, beside = false }: { state: State; beside?: boolean }) {
  // under the Codex meter in its own column the section needs no "codex" in its name
  const name = beside ? 'what moved it' : 'codex this week'
  const split = state.codex.split
  if (!split) return null
  const rows = split.threads.filter((row) => row.credits > 0)
  if (!rows.length) {
    return (
      <div className="cx-threads">
        <h2>{name}</h2>
        <p className="stripcap">no Codex calls in this week's rollouts yet</p>
      </div>
    )
  }
  const shown = rows.slice(0, THREAD_ROWS)
  const clock = (t: number) => (t < state.day.start ? dayClock(t) : hm(t))
  return (
    <div className="cx-threads">
      <h2>
        {name} · since {dayClock(split.from)} · {Math.round(split.pct)} points
      </h2>
      <div className="strip">
        {rows.map((row) => (
          <i key={row.id} style={{ width: `${row.share * 100}%`, background: row.color, color: labelOn(row.color) }}>
            {row.share >= 0.06 && row.points !== null ? row.points.toFixed(1) : ''}
          </i>
        ))}
      </div>
      <div className="stripcap">
        the {Math.round(split.pct)} points, split by credits from OpenAI's Codex rate card
        {split.creditsPerPoint === null ? '' : ` · this week a point is about ${credits(split.creditsPerPoint)}`}
      </div>
      {split.pendingCredits > 1 ? (
        <p className="warn">{credits(split.pendingCredits)} since the last reading ({hm(split.to)}) is not on the meter yet.</p>
      ) : null}
      {shown.map((row) => (
        <div className="row" key={row.id}>
          <div className="pts">
            <s style={{ background: row.color }} />
            <span className="share">{pct(row.share * 100)}</span>
          </div>
          <div className="name">
            <a href={`http://127.0.0.1:8080/sessions/codex:${row.id}?msg=last`} title={`${row.calls} calls · ${row.models.join(', ')}`}>
              {row.title}
            </a>
            <span className="meta">
              codex · {row.via}
              {row.points === null ? '' : <> · <span className="approx">~{row.points.toFixed(1)} pts</span></>}
              {` · ${credits(row.credits)}`}
              {row.unpriced ? ' (a model is not on the rate card, priced as Sol)' : ''}
              {row.subagents ? ` · ${row.subagents} subagent${row.subagents === 1 ? '' : 's'}` : ''}
              {row.live ? <> · <b className="lv">live</b></> : ''}
              {` · ${clock(row.start)}–${hm(row.end)}`}
            </span>
          </div>
        </div>
      ))}
      {rows.length > shown.length ? (
        <span className="more">… {rows.length - shown.length} more with a smaller share</span>
      ) : null}
      <p className="caveat">
        Split by credits across the meter's movement since the week opened, priced per model from the rate card.
        {split.pointSteps
          ? ` Single points ran ${Math.round(split.pointSteps.min)} to ${Math.round(split.pointSteps.max)} credits across ${split.pointSteps.count} steps this week, so each thread's points are approximate.`
          : ' Too few point steps yet to say how steady a point is.'}
      </p>
    </div>
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
