import { agentsview, type State } from '../api'
import { hm, labelOn, money, pct, tokens } from '../format'

/**
 * the block's measured jump, divided by list-price cost.
 *
 * share is the headline because share is what the evidence supports; the points
 * figure is a rounded convenience and the caveat under the list says so.
 */
export function BlockSplit({ state }: { state: State }) {
  const split = state.split
  const block = state.block
  if (!split || !block) return null
  const delta = block.delta
  const claude = split.sessions.filter((row) => row.share > 0)
  const missingBefore = split.costBeforeFirstSample
  const missingAfter = split.costAfterLastSample
  const since = state.week.since === 'lastLooked' ? `since ${hm(state.week.from)}` : 'today'

  return (
    <>
      <h2>
        {state.fiveHour?.ended ? `last block · ${hm(block.from)} to ${hm(block.resetsAt)}` : `this block · since ${hm(block.from)}`} ·{' '}
        {delta === null ? 'movement not measured' : `${Math.round(delta)} points`}
      </h2>
      <div className="strip">
        {claude.map((row) => (
          <i key={row.sessionId} style={{ width: `${row.share * 100}%`, background: row.color, color: labelOn(row.color) }}>
            {row.share >= 0.06 ? (row.points === null ? pct(row.share * 100) : row.points.toFixed(1)) : ''}
          </i>
        ))}
      </div>
      <div className="stripcap">
        {delta === null
          ? 'no measured jump to divide · shares only'
          : `the ${Math.round(delta)} points, split by session`}{' '}
        · Claude only, the other agents have no usage data
      </div>

      {missingBefore > 0.01 ? (
        <p className="warn">
          {money(missingBefore)} of this block ran before the first meter sample ({hm(block.from)}). no delta covers
          it, so it gets no points and no row.
        </p>
      ) : null}
      {missingAfter > 0.01 ? (
        <p className="warn">
          {state.fiveHour?.ended
            ? `${money(missingAfter)} ran between the last sample (${hm(block.to)}) and the reset, so no reading covers it.`
            : `${money(missingAfter)} since the last sample (${hm(block.to)}) is not on the meter yet.`}
        </p>
      ) : null}

      {claude.map((row) => (
        <div className="row" key={row.sessionId}>
          <div className="pts">
            <s style={{ background: row.color }} />
            <span className="share">{pct(row.share * 100)}</span>
          </div>
          <div className="name">
            <a href={agentsview(row.sessionId)} title={`${tokens(row.tokens)} tokens · ${money(row.cost)} list price`}>
              {row.title ?? row.sessionId.slice(0, 8)}
            </a>
            <span className="meta">
              claude
              {row.points === null ? '' : <> · <span className="approx">~{row.points.toFixed(1)} pts</span></>}
              {row.fableShare ? ` · ${pct(row.fableShare * 100)} of ${state.fable?.model ?? 'Fable'} ${since}` : ''}
              {row.subagents ? ` · ${row.subagents} subagent${row.subagents === 1 ? '' : 's'}` : ''}
              {row.live ? <> · <b className="lv">live</b></> : ''}
              {` · ${hm(row.start)}–${hm(row.end)}`}
            </span>
          </div>
        </div>
      ))}

      {state.others.map((row) => (
        <div className="row" key={row.id}>
          <div className="pts">
            <s style={{ background: row.color }} />
            <span className="nd">n/a</span>
          </div>
          <div className="name">
            {row.title}
            <span className="meta">
              {row.kind}
              {row.live ? <> · <b className="lv">live</b></> : ''}
              {` · ${hm(row.start)}–${hm(row.end)}`}
            </span>
          </div>
        </div>
      ))}

      <p className="caveat">{state.caveat}</p>
    </>
  )
}
