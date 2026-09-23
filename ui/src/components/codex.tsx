import type { ReactNode } from 'react'
import { agentsview, type State } from '../api'
import { ago, dayClock, days, hm } from '../format'
import { sessionHref } from '../route'
import { Ledger, Question, Strip, type LedgerRow } from './ledger'
import { capital, clip, countWord, listOf, plural, points, share } from './words'

type CodexView = State['codex']
type Thread = NonNullable<CodexView['split']>['threads'][number]

/** threads under this share fold into one row; there is always a tail of tiny ones */
const SMALL_SHARE = 0.03

/** `1,204` */
function credits(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** a clock time that says the day when it is not today */
function when(state: State, t: number): string {
  return t < state.day.start ? dayClock(t) : hm(t)
}

/** the Codex verdict as the letter and the section both say it */
export function codexVerdict(codex: CodexView): { tone: string; head: string; rest: ReactNode } {
  const pace = codex.pace
  if (codex.status === 'stale' || !pace) {
    return { tone: 'bad', head: 'reading is stale,', rest: 'so there is no pace from an old number' }
  }
  if (!pace.ready) return { tone: 'mute', head: 'no pace yet,', rest: pace.reason ?? '' }
  if (pace.hitsHundredAt !== null) {
    return { tone: 'bad', head: `hits 100% ${dayClock(pace.hitsHundredAt)},`, rest: 'before the reset' }
  }
  return {
    tone: 'ok',
    head: 'fits,',
    rest: (
      <>
        <span className="cmp">≈ {Math.round(pace.pctAtReset ?? 0)}%</span> at reset
        {pace.provisional ? ' (provisional)' : ''}
      </>
    ),
  }
}

/** the reading's age, or its clock time on a frozen page where an age would count from the past */
export function codexRead(codex: CodexView, frozen: boolean): string {
  if (codex.sampledAt !== null && frozen) return `sampled ${hm(codex.sampledAt)}`
  return codex.ageSeconds === null ? 'never read' : `read ${ago(codex.ageSeconds)}`
}

/**
 * "what ate the codex week": the same ledger as the Claude block, over the Codex
 * weekly meter, split by rate-card credits off the rollout files. there is no
 * dollar figure here on purpose; Codex is counted in credits.
 */
export function CodexSection({ state, frozen }: { state: State; frozen: boolean }) {
  const codex = state.codex
  if (codex.status === 'absent') return null
  const split = codex.split
  if (codex.status === 'unavailable' || !split) {
    return (
      <Question id="q-codex" title="What ate the codex week" lead={codex.line.replace(/^Codex · /, '')}>
        {null}
      </Question>
    )
  }
  const threads = split.threads.filter((thread) => thread.credits > 0)
  const big = threads.filter((thread) => thread.share >= SMALL_SHARE)
  const small = threads.filter((thread) => thread.share < SMALL_SHARE)
  const pct = codex.usedPercent
  const verdict = codexVerdict(codex)
  const rows: LedgerRow[] = big.map((thread) => threadRow(state, thread, frozen))
  if (small.length) rows.push(smallRow(state, small))

  const columns = [
    {
      head: (
        <>
          of the week
          <br />
          {Math.round(split.pct)} pts since {dayClock(split.from).slice(0, 3)}
        </>
      ),
      width: '132px',
    },
    { head: 'credits', width: '92px' },
    { head: 'when', width: '118px' },
  ]

  const lead: ReactNode = (
    <>
      Codex is at <b>{pct === null ? '–' : `${Math.round(pct)}%`}</b>
      {codex.resetsAt !== null ? ` with ${days(codex.resetsAt - state.now)} to go` : ''};{' '}
      <span className={verdict.tone}>{verdict.head}</span> {verdict.rest}.{' '}
      {big[0] ? (
        <>
          {clip(big[0].title, 48)} ate <b className="cmp">{share(big[0].share)}</b> of the week
          {big[1] ? (
            <>
              , {clip(big[1].title, 48)} <b className="cmp">{share(big[1].share)}</b>
            </>
          ) : null}
          .
        </>
      ) : (
        'No Codex calls in this week’s rollouts yet.'
      )}
    </>
  )

  return (
    <Question
      id="q-codex"
      title="What ate the codex week"
      lead={lead}
      aside={
        <div className="aside">
          Counted in rate-card credits, not dollars.
          {split.creditsPerPoint === null ? '' : ` A point cost about ${credits(split.creditsPerPoint)} credits this week`}
          {split.pointSteps
            ? `, single steps ran ${credits(split.pointSteps.min)} to ${credits(split.pointSteps.max)}, so each thread’s points are approximate.`
            : '. Too few point steps yet to say how steady a point is.'}
          {split.pendingCredits > 1 ? ` ${credits(split.pendingCredits)} credits since the last reading (${hm(split.to)}) are not on the meter yet.` : ''}
        </div>
      }
    >
      <div className="two">
        <div>
          <Strip
            parts={threads.map((thread) => ({
              key: thread.id,
              share: thread.share,
              color: thread.color,
              tip: (
                <>
                  <b>{thread.title}</b>
                  <br />
                  {share(thread.share)} of the week{thread.points === null ? '' : `, ${points(thread.points)} points`}
                </>
              ),
            }))}
          />
          {rows.length ? <Ledger first="thread · models" columns={columns} rows={rows} /> : null}
        </div>
        <div>
          <WeekChart codex={codex} now={frozen ? null : state.now} />
        </div>
      </div>
    </Question>
  )
}

function threadRow(state: State, thread: Thread, frozen: boolean): LedgerRow {
  const transcript = agentsview(state.agentsviewUrl, `codex:${thread.id}`)
  return {
    key: thread.id,
    color: thread.color,
    name: clip(thread.title, 56),
    tags: thread.live ? <span className="live">live</span> : undefined,
    subtitle: [
      `via ${thread.via}`,
      thread.subagents ? plural(thread.subagents, 'subagent') : '',
      thread.models.join(' + ') || 'no model recorded',
    ]
      .filter(Boolean)
      .join(' · '),
    cells: [
      {
        main: <span className="cmp">{share(thread.share)}</span>,
        sub: thread.points === null ? 'no points' : `${points(thread.points)} pts`,
      },
      { main: credits(thread.credits), sub: plural(thread.calls, 'call'), small: true },
      { main: when(state, thread.start), sub: `to ${when(state, thread.end)}`, small: true },
    ],
    more: (
      <div>
        <p>
          It ran via {thread.via} from {when(state, thread.start)} to {when(state, thread.end)}:{' '}
          {plural(thread.calls, 'call')} on {listOf(thread.models)}
          {thread.subagents ? `, ${plural(thread.subagents, 'subagent')} among them` : ''}. {credits(thread.credits)}{' '}
          rate-card credits, <span className="cmp">{share(thread.share)}</span> of the week’s movement
          {thread.points === null ? '' : (
            <>
              , about <span className="cmp">{points(thread.points)}</span> points
            </>
          )}
          .{thread.unpriced ? ' A model it used is not on the rate card, so it is priced as Sol.' : ''}
        </p>
        <div className="links">
          <a href={sessionHref(`codex:${thread.id}`, frozen ? state.now : undefined)}>open the thread →</a>
          {transcript ? (
            <a href={transcript} target="_blank" rel="noopener">
              transcript in AgentsView ↗
            </a>
          ) : null}
        </div>
      </div>
    ),
  }
}

/** the tail of tiny threads as one row that opens into a line each */
function smallRow(state: State, small: Thread[]): LedgerRow {
  const total = small.reduce((sum, thread) => sum + thread.share, 0)
  return {
    key: 'small',
    color: small[0]!.color,
    name: `${capital(countWord(small.length))} small threads`,
    subtitle: listOf(small.map((thread) => thread.title)),
    cells: [
      { main: <span className="cmp">{share(total)}</span>, sub: 'together' },
      {
        main: credits(small.reduce((sum, thread) => sum + thread.credits, 0)),
        sub: plural(
          small.reduce((sum, thread) => sum + thread.calls, 0),
          'call',
        ),
        small: true,
      },
      { main: '', small: true },
    ],
    more: (
      <div>
        {small.map((thread) => (
          <p key={thread.id}>
            <a href={sessionHref(`codex:${thread.id}`)}>{thread.title}</a>: <span className="cmp">{share(thread.share)}</span>,{' '}
            {credits(thread.credits)} credits, {plural(thread.calls, 'call')} on {listOf(thread.models)},{' '}
            {when(state, thread.start)}–{when(state, thread.end)}.
          </p>
        ))}
      </div>
    ),
  }
}

/** the chart's own coordinate space; it stretches to the column */
const W = 440
const H = 190
const LEFT = 34
const RIGHT = 60
const TOP = 16
const PLOT = 140

/** the window from open to reset: readings, and the expected path to it, flat and shaded on weekends */
function WeekChart({ codex, now }: { codex: CodexView; now: number | null }) {
  const { windowStart, resetsAt, history, pace } = codex
  if (windowStart === null || resetsAt === null) return null
  const x = (t: number) => LEFT + ((t - windowStart) / (resetsAt - windowStart)) * (W - LEFT - RIGHT)
  const y = (value: number) => TOP + PLOT - (Math.min(100, Math.max(0, value)) / 100) * PLOT
  const day = 86400
  const dayStarts: number[] = []
  // local midnights: step by hours and keep the ones where the date turns over
  for (let t = windowStart; t < resetsAt; t += 3600) {
    if (hm(t).startsWith('00:')) dayStarts.push(t - (Number(hm(t).slice(3)) * 60 + (Math.floor(t) % 60)))
  }
  const runs: string[] = []
  for (const [index, point] of history.entries()) {
    const at = `${x(point.t).toFixed(1)},${y(point.pct).toFixed(1)}`
    runs.push(`${index === 0 || point.afterGap ? 'M' : 'L'}${at}`)
  }
  const last = history.at(-1)
  const path = pace?.ready && pace.path.length > 1 ? pace.path.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}`).join('') : null
  const edges = [windowStart, ...dayStarts, resetsAt]
  return (
    <div className="chart cx-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Codex weekly meter over the week">
        {edges.slice(0, -1).map((start, index) => {
          const end = edges[index + 1]!
          const name = dayClock(start + Math.min(day / 2, (end - start) / 2)).slice(0, 3)
          const weekend = name === 'Sat' || name === 'Sun'
          return (
            <g key={start}>
              {weekend ? <rect x={x(start)} y={TOP} width={x(end) - x(start)} height={PLOT} className="weekend" /> : null}
              {index > 0 ? <line x1={x(start)} x2={x(start)} y1={TOP} y2={TOP + PLOT} className="grid" /> : null}
              {x(end) - x(start) > 24 ? (
                <text x={(x(start) + x(end)) / 2} y={TOP + PLOT + 18} textAnchor="middle" className="tk">
                  {name}
                </text>
              ) : null}
            </g>
          )
        })}
        {[0, 50, 100].map((value) => (
          <g key={value}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(value)} y2={y(value)} className="grid" />
            <text x={LEFT - 8} y={y(value) + 4} textAnchor="end" className="tk">
              {value}
            </text>
          </g>
        ))}
        {path ? <path d={path} className="cx-proj" /> : null}
        <path d={runs.join('')} className="cx-line" />
        {last ? (
          <>
            <circle cx={x(last.t)} cy={y(last.pct)} r={4} className="cx-dot" />
            <text x={x(last.t) + 8} y={y(last.pct) - 10} className="lbl-strong">
              {Math.round(last.pct)}%{now === null ? '' : ' now'}
            </text>
          </>
        ) : null}
        {pace?.ready && pace.pctAtReset !== null ? (
          <text x={W - RIGHT + 8} y={y(pace.pctAtReset) + 4} className="lbl">
            ≈ {Math.round(pace.pctAtReset)}%
          </text>
        ) : null}
      </svg>
      <div className="foot">
        The Codex meter since {dayClock(windowStart)}
        {path ? '; dashed is the expected path, flat on the shaded weekend' : ''}
        {history.some((point) => point.afterGap) ? '; a jump in the line is a stretch the reader missed' : ''}.
      </div>
    </div>
  )
}
