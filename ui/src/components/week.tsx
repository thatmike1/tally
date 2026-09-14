import { agentsview, type SessionRow, type State } from '../api'
import { dayClock, hm, labelOn, money, pct } from '../format'

type WeekSplit = NonNullable<State['week']['weekly']>

/** rows with no Fable requests are secondary here; past this many they fold into a count */
const QUIET_ROWS = 8

/**
 * which sessions moved the weekly and Fable meters since the last look, or today.
 *
 * the Fable strip holds only sessions with Fable requests, so a big Opus-only
 * session that owns the block strip is absent from it; the list puts the Fable
 * movers first and draws a line under them to make that absence read as an answer.
 */
export function Week({ state }: { state: State }) {
  const week = state.week
  const fableName = state.fable?.model ?? 'Fable'
  const clock = (t: number) => (t < state.day.start ? dayClock(t) : hm(t))
  const title = week.since === 'lastLooked' ? `since you last looked · ${clock(week.from)}` : 'today'
  const { weekly, fable } = week
  const first = weekly ?? fable
  const before = (weekly ?? fable)?.costBeforeFirstSample ?? 0
  const after = (weekly ?? fable)?.costAfterLastSample ?? 0

  return (
    <>
      <h2 style={{ marginTop: 44 }}>{title}</h2>
      <p className="calc">
        {movement(weekly, fable, fableName, clock)}
        <small>computed, no model</small>
      </p>

      <div className="wstrips">
        <WindowStrip label="weekly" split={weekly} caption={(d) => `the ${points(d)}, split by cost weighted per model`} />
        <WindowStrip
          label={fableName}
          split={fable}
          caption={(d) => `the ${points(d)}, split by ${fableName} cost only`}
        />
      </div>

      {first && before > 0.01 ? (
        <p className="warn">
          {money(before)} ran between {clock(week.from)} and the first meter reading ({clock(first.from)}). no delta
          covers it, so it is in neither strip.
        </p>
      ) : null}
      {first && after > 0.01 ? (
        <p className="warn">
          {money(after)} since the last reading ({hm(first.to)}) is not on the meters yet.
        </p>
      ) : null}

      <List weekly={weekly} fable={fable} fableName={fableName} since={week.since === 'today' ? 'today' : `since ${clock(week.from)}`} />
      <p className="caveat">{week.caveat}</p>
    </>
  )
}

function points(n: number): string {
  return n === 1 ? '1 point' : `${n} points`
}

/** `Weekly 75 → 82, Fable 87 → 92 since 16:35.`, from the readings each split snapped to */
function movement(
  weekly: WeekSplit | null,
  fable: WeekSplit | null,
  fableName: string,
  clock: (t: number) => string,
): string {
  const bits: string[] = []
  if (weekly) bits.push(`Weekly ${Math.round(weekly.startPct)} → ${Math.round(weekly.endPct)}`)
  if (fable) bits.push(`${fableName} ${Math.round(fable.startPct)} → ${Math.round(fable.endPct)}`)
  const first = weekly ?? fable
  if (!first) return 'no weekly meter reading in this window yet.'
  return `${bits.join(', ')} since ${clock(first.from)}.`
}

function WindowStrip({
  label,
  split,
  caption,
}: {
  label: string
  split: WeekSplit | null
  caption: (delta: number) => string
}) {
  if (!split) {
    return (
      <>
        <div className="wl">{label}</div>
        <div>
          <div className="strip" />
          <div className="stripcap">no reading of this meter in the window</div>
        </div>
      </>
    )
  }
  if (split.crossedReset) {
    return (
      <>
        <div className="wl">{label}</div>
        <div>
          <div className="strip" />
          <div className="stripcap warn">
            the weekly reset fell inside this window ({Math.round(split.startPct)} → {Math.round(split.endPct)}), so
            nothing is split
          </div>
        </div>
      </>
    )
  }
  const rows = split.sessions.filter((row) => row.share > 0)
  const delta = split.delta
  const note =
    delta === null
      ? 'one reading so far, no movement to divide · shares only'
      : delta === 0
        ? 'the meter did not move · shares only'
        : caption(Math.round(delta))
  return (
    <>
      <div className="wl">{label}</div>
      <div>
        <div className="strip">
          {rows.map((row) => (
            <i key={row.sessionId} style={{ width: `${row.share * 100}%`, background: row.color, color: labelOn(row.color) }}>
              {row.share >= 0.06 ? (row.points === null ? pct(row.share * 100) : row.points.toFixed(1)) : ''}
            </i>
          ))}
        </div>
        <div className="stripcap">
          {note}
          {rows.length ? ` · ${rows.length} session${rows.length === 1 ? '' : 's'}` : ' · nothing spent on it'}
        </div>
      </div>
    </>
  )
}

interface ListRow {
  row: SessionRow
  fable: SessionRow | null
  weekly: SessionRow | null
}

function List({
  weekly,
  fable,
  fableName,
  since,
}: {
  weekly: WeekSplit | null
  fable: WeekSplit | null
  fableName: string
  since: string
}) {
  const byId = new Map<string, ListRow>()
  for (const row of fable?.sessions ?? []) {
    if (row.share > 0) byId.set(row.sessionId, { row, fable: row, weekly: null })
  }
  for (const row of weekly?.sessions ?? []) {
    if (row.share <= 0) continue
    const found = byId.get(row.sessionId)
    // the weekly row carries every request, so it is the better source for the meta line
    if (found) Object.assign(found, { row: { ...row, color: found.row.color }, weekly: row })
    else byId.set(row.sessionId, { row, fable: null, weekly: row })
  }
  const all = [...byId.values()].sort(
    (a, b) => (b.fable?.share ?? 0) - (a.fable?.share ?? 0) || (b.weekly?.share ?? 0) - (a.weekly?.share ?? 0),
  )
  if (!all.length) return null
  const movers = all.filter((item) => item.fable)
  const quiet = all.filter((item) => !item.fable)
  const shown = quiet.slice(0, QUIET_ROWS)
  const fableSplit = fable && !fable.crossedReset

  return (
    <>
      <div className="wrow whead">
        <div>{fableName}</div>
        <div />
        <div>weekly</div>
      </div>
      {movers.map((item) => (
        <Row key={item.row.sessionId} item={item} fableName={fableName} />
      ))}
      {fableSplit && quiet.length ? (
        <div className="wsep">
          {movers.length
            ? `no ${fableName} requests ${since} in the rows below: the ${fableName} movement is all in the ${movers.length === 1 ? 'row' : `${movers.length} rows`} above`
            : `no ${fableName} requests ${since}`}
        </div>
      ) : null}
      {shown.map((item) => (
        <Row key={item.row.sessionId} item={item} fableName={fableName} />
      ))}
      {quiet.length > shown.length ? (
        <span className="more">
          … {quiet.length - shown.length} more with a smaller weekly share and no {fableName}
        </span>
      ) : null}
    </>
  )
}

function Row({ item, fableName }: { item: ListRow; fableName: string }) {
  const { row, fable, weekly } = item
  return (
    <div className="wrow">
      <div className="pts">
        <s style={{ background: row.color }} />
        {fable ? <span className="share">{pct(fable.share * 100)}</span> : <span className="nd">—</span>}
      </div>
      <div className="name">
        <a href={agentsview(row.sessionId)} title={`${money(row.cost)} list price since the window opened`}>
          {row.title ?? row.sessionId.slice(0, 8)}
        </a>
        <span className="meta">
          claude
          {fable ? (
            <>
              {' · '}
              {fable.points === null ? '' : <span className="approx">~{fable.points.toFixed(1)} pts · </span>}
              {money(fable.cost)} {fableName}
            </>
          ) : null}
          {row.subagents ? ` · ${row.subagents} subagent${row.subagents === 1 ? '' : 's'}` : ''}
          {row.live ? <> · <b className="lv">live</b></> : ''}
          {` · ${hm(row.start)}–${hm(row.end)}`}
        </span>
      </div>
      <div className="wk2">
        {weekly ? (
          <>
            {pct(weekly.share * 100)}
            {weekly.points === null ? null : <span className="approx">~{weekly.points.toFixed(1)} pts</span>}
          </>
        ) : (
          <span className="nd">—</span>
        )}
      </div>
    </div>
  )
}
