import type { ReactNode } from 'react'
import { agentsview, type SessionRow, type State, type WeekMode } from '../api'
import { dayClock, hm, money, tokens } from '../format'
import { sessionHref } from '../route'
import { Ledger, Question, Strip, UsageTotals, type Column, type LedgerRow } from './ledger'
import { MiniLane } from './when'
import {
  USUAL_EFFORT,
  activeLabel,
  activeWithin,
  capital,
  countWord,
  effortLevels,
  lanesById,
  listOf,
  modelName,
  plural,
  points,
  realModels,
  rowName,
  rowSubtitle,
  sentenceName,
  share,
  timesWord,
} from './words'

type WeekSplit = NonNullable<State['week']['weekly']>

/** `today`, `this week`, `since 09:40`: the window the weekly and Fable columns cover */
export function sinceWord(state: State): string {
  const week = state.week
  if (week.since === 'today') return 'today'
  if (week.since === 'week') return 'this week'
  return `since ${week.from < state.day.start ? dayClock(week.from) : hm(week.from)}`
}

/** a weekly split that can be divided: read, and not cut in two by a reset */
function usable(split: WeekSplit | null): WeekSplit | null {
  return split && !split.crossedReset ? split : null
}

/** Fable gets a column only when it moved; a still meter has nothing to split */
export function fableMoved(state: State): boolean {
  const fable = usable(state.week.fable)
  return fable !== null && ((fable.delta ?? 0) > 0 || fable.sessions.some((row) => row.share > 0))
}

/** the effort after the model: the usual level quiet, anything else marked */
function Effort({ row }: { row: SessionRow }) {
  const levels = effortLevels(row)
  if (!levels.length) return null
  return (
    <>
      {' · '}
      {levels.map((level, index) => (
        <span key={level}>
          {index ? '/' : ''}
          <span className={level === USUAL_EFFORT ? undefined : 'eff'}>{level}</span>
        </span>
      ))}
    </>
  )
}

function Tags({ row }: { row: SessionRow }) {
  const models = realModels(row.models).map((one) => modelName(one.model))
  return (
    <>
      {models.join(' + ') || 'claude'}
      <Effort row={row} />
      {row.subagents ? ` · ${plural(row.subagents, 'subagent')}` : ''}
      {row.live ? (
        <>
          {' · '}
          <span className="live">live</span>
        </>
      ) : null}
    </>
  )
}

/** the links every opened row ends on */
function Links({ state, id, frozen }: { state: State; id: string; frozen: boolean }) {
  const transcript = agentsview(state.agentsviewUrl, id)
  return (
    <div className="links">
      <a href={sessionHref(id, frozen ? state.now : undefined)}>open the session →</a>
      {transcript ? (
        <a href={transcript} target="_blank" rel="noopener">
          transcript in AgentsView ↗
        </a>
      ) : null}
    </div>
  )
}

/** what a row is made of: its models, its effort levels and its tokens by kind */
function Makeup({ row }: { row: SessionRow }) {
  const models = realModels(row.models)
  const levels = row.effort
  const { buckets } = row
  return (
    <dl className="kv">
      <dt>models</dt>
      <dd>
        {models.length
          ? models.map((one) => `${modelName(one.model)} ${plural(one.requests, 'request')}, ${money(one.cost)}`).join(' · ')
          : 'none recorded'}
      </dd>
      <dt>effort</dt>
      <dd>
        {levels.map((one) => `${one.effort ?? 'not recorded'} ${plural(one.requests, 'request')}`).join(' · ') || 'not recorded'}
      </dd>
      <dt>tokens</dt>
      <dd>
        cache reads {tokens(buckets.cr)} · cache writes 5m {tokens(buckets.cw5m)}, 1h {tokens(buckets.cw1h)} · output{' '}
        {tokens(buckets.out)} · input {tokens(buckets.in)}
      </dd>
    </dl>
  )
}

/**
 * "what ate this block": the block's measured jump, divided by list-price cost,
 * one row per session with its weekly and Fable shares on the same line.
 */
export function BlockSection({
  state,
  frozen,
  weekMode,
  onWeekMode,
  title = 'What ate this block',
}: {
  state: State
  frozen: boolean
  weekMode: WeekMode
  onWeekMode?: ((mode: WeekMode) => void) | undefined
  title?: string
}) {
  const split = state.split
  const block = state.block
  if (!split || !block) {
    return (
      <Question id="q-ate" title={title} lead="There is no meter reading in the log yet, so there is no block to split.">
        {null}
      </Question>
    )
  }
  const rows = split.sessions.filter((row) => row.share > 0)
  const weekly = usable(state.week.weekly)
  const weeklyById = new Map((weekly?.sessions ?? []).map((row) => [row.sessionId, row]))
  // a Fable column of dashes says nothing: it shows only when a row in this block moved Fable
  const showFable = fableMoved(state) && rows.some((row) => (row.fableShare ?? 0) > 0)
  const fableName = state.fable?.model ?? 'Fable'
  const fable = usable(state.week.fable)
  const lanes = lanesById(state)
  const from = block.start
  const to = Math.min(state.now, block.resetsAt)
  const since = sinceWord(state)
  const delta = block.delta

  const columns: Column[] = [
    {
      head: (
        <>
          of this block
          <br />
          {delta === null ? 'no measured jump' : `${Math.round(delta)} pts since ${hm(split.from)}`}
        </>
      ),
      width: '124px',
    },
  ]
  if (weekly) {
    columns.push({
      head: (
        <>
          of weekly
          <br />
          {weekly.delta === null ? 'not measured' : `${Math.round(weekly.delta)} pts ${since}`}
        </>
      ),
      width: '118px',
    })
  }
  if (showFable && fable) {
    columns.push({
      head: (
        <>
          of {fableName}
          <br />
          {fable.delta === null ? 'not measured' : `${Math.round(fable.delta)} pts ${since}`}
        </>
      ),
      width: '118px',
    })
  }
  columns.push({ head: 'tokens', width: '104px' }, { head: 'list cost', width: '100px' }, {
    head: (
      <>
        active
        <br />
        in this block
      </>
    ),
    width: '118px',
  })

  const ledgerRows: LedgerRow[] = rows.map((row) => {
    const lane = lanes.get(row.sessionId)
    const segments = (lane?.segments ?? []).filter((one) => one.end > from && one.start < to)
    const active = lane ? activeWithin(segments, from, to) : null
    const wk = weeklyById.get(row.sessionId) ?? null
    const name = rowName(row)
    const cells = [
      {
        main: <span className="cmp">{share(row.share)}</span>,
        sub: row.points === null ? 'no points' : `${points(row.points)} pts`,
      },
    ]
    if (weekly) {
      cells.push({
        main: wk && wk.share > 0 ? <span className="cmp">{share(wk.share)}</span> : <span className="nd">—</span>,
        sub: wk && wk.share > 0 ? (wk.points === null ? '' : `${points(wk.points)} pts`) : 'not on it',
      })
    }
    if (showFable && fable) {
      cells.push({
        main: row.fableShare ? <span className="cmp">{share(row.fableShare)}</span> : <span className="nd">—</span>,
        sub: row.fableShare ? (row.fablePoints === null ? '' : `${points(row.fablePoints)} pts`) : `no ${fableName}`,
      })
    }
    const stretches = segments.map((one) => `${hm(Math.max(one.start, from))}–${hm(Math.min(one.end, to))}`)
    const more = (
      <>
        <div>
          {stretches.length ? (
            <p>
              It worked {timesWord(stretches.length)} in this block
              {stretches.length === 1 ? `, ${stretches[0]}` : `: ${listOf(stretches)}`},{' '}
              <span className="cmp">{activeLabel(active ?? 0)}</span> active in all.
            </p>
          ) : null}
          <p>
            {plural(row.requests, 'request')}
            {row.subagents ? `, some of them through ${plural(row.subagents, 'subagent')}` : ''}, {tokens(row.tokens)}{' '}
            tokens, {money(row.cost)} at list price. That is <span className="cmp">{share(row.share)}</span> of the
            block
            {delta === null ? '' : `’s ${Math.round(delta)}-point jump`}
            {row.points === null ? '' : (
              <>
                , about <span className="cmp">{points(row.points)}</span> points
              </>
            )}
            {weekly && weekly.delta !== null ? (
              <>
                , and <span className="cmp">{wk ? share(wk.share) : 'none'}</span> of the {Math.round(weekly.delta)}{' '}
                weekly points {since}
              </>
            ) : null}
            {showFable ? (
              <>
                ; {fableName}: {row.fableShare ? <span className="cmp">{share(row.fableShare)}</span> : 'none'} of its
                movement
              </>
            ) : null}
            .
            {row.unpriced ? ' Some of its requests have no price row, so its cost and share are short by whatever those cost.' : ''}
          </p>
          <Makeup row={row} />
          <Links state={state} id={row.sessionId} frozen={frozen} />
        </div>
        {lane ? (
          <MiniLane
            segments={lane.segments}
            from={block.start}
            to={block.resetsAt}
            now={frozen ? null : state.now}
            color={row.color}
          />
        ) : (
          <div className="foot">no activity on today’s lanes for this session</div>
        )}
      </>
    )
    return {
      key: row.sessionId,
      color: row.color,
      name,
      tags: <Tags row={row} />,
      subtitle: rowSubtitle(row),
      cells: [
        ...cells,
        { main: tokens(row.tokens), sub: plural(row.requests, 'request'), small: true },
        {
          main: `${money(row.cost)}${row.unpriced ? '*' : ''}`,
          sub: row.unpriced ? 'a floor' : 'list price',
          small: true,
        },
        {
          main: active === null ? <span className="nd">—</span> : activeLabel(active),
          sub: segments.length
            ? `${hm(Math.max(segments[0]!.start, from))}–${hm(Math.min(segments.at(-1)!.end, to))}`
            : '',
          small: true,
        },
      ],
      more,
    }
  })

  const top = rows.slice(0, 2)
  const topShare = top.reduce((sum, row) => sum + row.share, 0)
  const count = rows.length
  const lead: ReactNode = !count ? (
    'Nothing on the Claude transcripts ran in this block yet.'
  ) : (
    <>
      {capital(countWord(count))} Claude {count === 1 ? 'session' : 'sessions'}{' '}
      {delta === null ? (
        <>share the cost since {hm(split.from)}; the meter has not moved across a measured span yet.</>
      ) : (
        <>
          {count === 1 ? 'owns' : 'share'} the {Math.round(delta)} points since {hm(split.from)}.
        </>
      )}{' '}
      {count >= 2 ? (
        <>
          {sentenceName(top[0]!)} and {sentenceName(top[1]!)} took <b className="cmp">{share(topShare)}</b> between them.
        </>
      ) : null}
    </>
  )

  return (
    <Question
      id="q-ate"
      title={title}
      lead={lead}
      aside={
        <div className="aside">
          Each session is listed once, with its share of the block and of the weekly movement {since} on the same
          line. Open a row for its hours, its token mix and its links.
        </div>
      }
    >
      <UsageTotals usage={split.usage} />
      <Strip
        parts={rows.map((row) => ({
          key: row.sessionId,
          share: row.share,
          color: row.color,
          tip: (
            <>
              <b>{rowName(row)}</b>
              <br />
              {share(row.share)} of the block{row.points === null ? '' : `, ${points(row.points)} points`}
            </>
          ),
        }))}
      />
      {rows.length ? <Ledger first="session · model · effort" columns={columns} rows={ledgerRows} open={devOpen(rows.map((row) => row.sessionId))} /> : null}
      <WeekLine state={state} weekMode={weekMode} onWeekMode={onWeekMode} fableHere={showFable} />
      <OtherAgents state={state} from={from} to={to} />
    </Question>
  )
}

/**
 * "how is the week going", demoted to one line under the ledger: the weekly
 * column above divides exactly this movement.
 */
function WeekLine({
  state,
  weekMode,
  onWeekMode,
  fableHere,
}: {
  state: State
  weekMode: WeekMode
  onWeekMode?: ((mode: WeekMode) => void) | undefined
  /** whether the ledger above has a Fable column */
  fableHere: boolean
}) {
  const since = sinceWord(state)
  const weekly = state.week.weekly
  const fable = state.week.fable
  const fableName = state.fable?.model ?? 'Fable'
  const bits: ReactNode[] = []
  if (!weekly) bits.push('No weekly reading in this window yet.')
  else if (weekly.crossedReset) bits.push(`The weekly reset fell inside this window, so the weekly column is empty.`)
  else {
    bits.push(
      <span key="w">
        Weekly moved{' '}
        <b>
          {Math.round(weekly.startPct)}% → {Math.round(weekly.endPct)}%
        </b>{' '}
        {since}; the weekly column splits those points.
      </span>,
    )
  }
  if (fable && !fable.crossedReset) {
    bits.push(
      (fable.delta ?? 0) > 0 ? (
        <span key="f">
          {' '}
          {fableName} moved {Math.round(fable.startPct)}% → {Math.round(fable.endPct)}%
          {fableHere ? '.' : ', none of it in this block, so it has no column.'}
        </span>
      ) : (
        <span key="f">
          {' '}
          {fableName} stayed at {Math.round(fable.endPct)}%, so it has no column.
        </span>
      ),
    )
  }
  return (
    <div className="foot weekline">
      <span>{bits}</span>
      {onWeekMode ? (
        <span className="modes">
          <button type="button" aria-pressed={weekMode === 'recent'} onClick={() => onWeekMode('recent')}>
            {state.week.since === 'lastLooked' ? 'since you last looked' : 'today'}
          </button>
          <button type="button" aria-pressed={weekMode === 'whole'} onClick={() => onWeekMode('whole')}>
            whole week
          </button>
        </span>
      ) : null}
    </div>
  )
}

/** the agents with no Claude meter that ran inside the block, named rather than listed */
function OtherAgents({ state, from, to }: { state: State; from: number; to: number }) {
  const inside = state.day.lanes.filter(
    (lane) => lane.kind !== 'claude' && lane.segments.some((one) => one.end > from && one.start < to),
  )
  if (!inside.length) return null
  const codex = inside.filter((lane) => lane.kind === 'codex')
  const rest = inside.filter((lane) => lane.kind !== 'codex')
  return (
    <div className="foot">
      {codex.length ? (
        <>
          {capital(listOf(codex.map((lane) => lane.title)))} also ran in this block on Codex, which has its own meter
          and its own ledger below.{' '}
        </>
      ) : null}
      {rest.length ? (
        <>
          {capital(listOf(rest.map((lane) => `${lane.title} (${lane.kind})`)))} ran here too, with no usage data to
          split.
        </>
      ) : null}
    </div>
  )
}

/**
 * "what ate this week", for a frozen week: the same ledger over the weekly
 * meter's movement, with the span each session ran in instead of active time.
 */
export function WeekSection({ state, frozen }: { state: State; frozen: boolean }) {
  const weekly = state.week.weekly
  const fableName = state.fable?.model ?? 'Fable'
  if (!weekly || weekly.crossedReset) {
    return (
      <Question id="q-week" title="What ate this week" lead="There is no weekly movement to split in this window.">
        {null}
      </Question>
    )
  }
  const rows = weekly.sessions.filter((row) => row.share > 0)
  const showFable = fableMoved(state)
  const fable = usable(state.week.fable)
  const columns: Column[] = [
    {
      head: (
        <>
          of weekly
          <br />
          {weekly.delta === null ? 'not measured' : `${Math.round(weekly.delta)} pts this week`}
        </>
      ),
      width: '124px',
    },
  ]
  if (showFable && fable) {
    columns.push({
      head: (
        <>
          of {fableName}
          <br />
          {fable.delta === null ? 'not measured' : `${Math.round(fable.delta)} pts`}
        </>
      ),
      width: '118px',
    })
  }
  columns.push({ head: 'tokens', width: '104px' }, { head: 'list cost', width: '100px' }, { head: 'when', width: '150px' })
  const ledgerRows: LedgerRow[] = rows.map((row) => {
    const cells = [
      {
        main: <span className="cmp">{share(row.share)}</span>,
        sub: row.points === null ? 'no points' : `${points(row.points)} pts`,
      },
    ]
    if (showFable && fable) {
      cells.push({
        main: row.fableShare ? <span className="cmp">{share(row.fableShare)}</span> : <span className="nd">—</span>,
        sub: row.fableShare ? (row.fablePoints === null ? '' : `${points(row.fablePoints)} pts`) : `no ${fableName}`,
      })
    }
    return {
      key: row.sessionId,
      color: row.color,
      name: rowName(row),
      tags: <Tags row={row} />,
      subtitle: rowSubtitle(row),
      cells: [
        ...cells,
        { main: tokens(row.tokens), sub: plural(row.requests, 'request'), small: true },
        { main: `${money(row.cost)}${row.unpriced ? '*' : ''}`, sub: row.unpriced ? 'a floor' : 'list price', small: true },
        { main: dayClock(row.start), sub: `to ${dayClock(row.end)}`, small: true },
      ],
      more: (
        <>
          <div>
            <p>
              It ran from {dayClock(row.start)} to {dayClock(row.end)}: {plural(row.requests, 'request')}
              {row.subagents ? ` through ${plural(row.subagents, 'subagent')} as well as the main thread` : ''},{' '}
              {tokens(row.tokens)} tokens, {money(row.cost)} at list price. That is{' '}
              <span className="cmp">{share(row.share)}</span> of the week’s weekly movement
              {row.points === null ? '' : (
                <>
                  , about <span className="cmp">{points(row.points)}</span> points
                </>
              )}
              .
            </p>
            <Makeup row={row} />
            <Links state={state} id={row.sessionId} frozen={frozen} />
          </div>
        </>
      ),
    }
  })
  const top = rows.slice(0, 2)
  return (
    <Question
      id="q-week"
      title="What ate this week"
      lead={
        <>
          {capital(countWord(rows.length))} Claude {rows.length === 1 ? 'session' : 'sessions'} moved the weekly meter
          from <b>{Math.round(weekly.startPct)}%</b> to <b>{Math.round(weekly.endPct)}%</b>.{' '}
          {top.length === 2 ? (
            <>
              {sentenceName(top[0]!)} and {sentenceName(top[1]!)} took{' '}
              <b className="cmp">{share(top[0]!.share + top[1]!.share)}</b> between them.
            </>
          ) : null}
        </>
      }
      aside={<div className="aside">{state.week.caveat}</div>}
    >
      <UsageTotals usage={weekly.usage} />
      <Strip
        parts={rows.map((row) => ({
          key: row.sessionId,
          share: row.share,
          color: row.color,
          tip: (
            <>
              <b>{rowName(row)}</b>
              <br />
              {share(row.share)} of the week{row.points === null ? '' : `, ${points(row.points)} points`}
            </>
          ),
        }))}
      />
      {rows.length ? <Ledger first="session · model · effort" columns={columns} rows={ledgerRows} /> : null}
    </Question>
  )
}

/** dev only: `?open=1` opens the first row, so a headless screenshot can show an opened row */
export function devOpen(keys: string[]): string[] {
  if (!import.meta.env.DEV) return []
  const wanted = new URLSearchParams(window.location.search).get('open')
  if (!wanted) return []
  return wanted === '1' ? keys.slice(0, 1) : [wanted]
}
