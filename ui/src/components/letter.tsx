import type { ReactNode } from 'react'
import type { State } from '../api'
import { ago, dayClock, days, hm, until } from '../format'
import { codexRead, codexVerdict } from './codex'
import { capital, clip, countWord, listOf, sentenceName, share } from './words'

type MeterView = NonNullable<State['weekly']>

/**
 * the left panel: the answer, written down. the 5-hour number, its verdict and
 * one computed sentence naming what ate the block; weekly and Fable as verdict
 * lines; Codex as a second, smaller answer of its own. provenance signs off at
 * the bottom, never above the answer.
 */

const longDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

function dateline(t: number): string {
  return `${longDate.format(new Date(t * 1000)).toLowerCase()}, ${hm(t)}`
}

/** scroll to a section without touching the hash, which is the router */
function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

interface Named {
  name: string
  share: number
}

/** `A ate 41% of it, B 27%. C, D and E split the other 32%.` */
function AteSentence({ rows, what }: { rows: Named[]; what: string }) {
  const [first, second, ...others] = rows
  if (!first) return <>Nothing on the Claude transcripts ran in {what} yet.</>
  const rest = [...others]
  const pair = second && second.share >= 0.12
  if (second && !pair) rest.unshift(second)
  const restShare = rest.reduce((sum, row) => sum + row.share, 0)
  return (
    <>
      <b className="who-name">{first.name}</b> ate <b className="cmp">{share(first.share)}</b> of {what}
      {pair ? (
        <>
          , <b className="who-name">{second.name}</b> <b className="cmp">{share(second.share)}</b>
        </>
      ) : null}
      .{' '}
      {rest.length === 1 ? (
        <>
          {rest[0]!.name} took the other <span className="cmp">{share(restShare)}</span>.
        </>
      ) : rest.length > 1 && rest.length <= 3 ? (
        <>
          {listOf(rest.map((row) => row.name))} split the other <span className="cmp">{share(restShare)}</span>.
        </>
      ) : rest.length > 3 ? (
        <>
          {capital(countWord(rest.length))} smaller sessions split the other <span className="cmp">{share(restShare)}</span>.
        </>
      ) : null}
    </>
  )
}

function toneOf(phrase: string): string {
  if (phrase === 'over pace') return 'bad'
  if (phrase === 'one light day left') return 'warn'
  if (phrase === 'on pace' || phrase.includes('fits')) return 'ok'
  return ''
}

/** where a weekly meter lands if every workday left burns a typical one; the verdict's own arithmetic */
function landsNear(meter: MeterView): number | null {
  const verdict = meter.verdict
  if (!verdict || verdict.typicalDay === null) return null
  return Math.min(100, Math.round(meter.pct + verdict.typicalDay * verdict.workdaysLeft))
}

function MeterLine({ label, pct, verdict, sub }: { label: string; pct: ReactNode; verdict: ReactNode; sub: ReactNode }) {
  return (
    <div className="mline">
      <span className="mn">{label}</span>
      <span className="mp">{pct}</span>
      <span className="mv">
        {verdict}
        <span className="sub">{sub}</span>
      </span>
    </div>
  )
}

function WeeklyLine({ state, label, meter, extra }: { state: State; label: string; meter: MeterView | null; extra?: string }) {
  if (!meter) return null
  const verdict = meter.verdict
  const near = landsNear(meter)
  const left = verdict?.workdaysLeft ?? 0
  return (
    <MeterLine
      label={label}
      pct={`${Math.round(meter.pct)}%`}
      verdict={
        <>
          {verdict ? <b className={toneOf(verdict.phrase)}>{verdict.phrase}</b> : null}
          {extra ? `, ${extra}` : ''}
        </>
      }
      sub={
        <>
          {near !== null && left > 0 ? (
            <>
              {countWord(left)} typical {label === 'weekly' ? 'workday' : `${label} day`}
              {left === 1 ? ' lands it' : 's land it'} near <span className="cmp">{near}%</span> ·{' '}
            </>
          ) : null}
          {meter.resetsAt ? `resets ${dayClock(meter.resetsAt)}, in ${days(meter.resetsAt - state.now)}` : ''}
        </>
      }
    />
  )
}

/** Codex as its own answer: a real number, its verdict, and who ate it */
function CodexLetter({ state, frozen }: { state: State; frozen: boolean }) {
  const codex = state.codex
  if (codex.status === 'absent') return null
  if (codex.status === 'unavailable') {
    return (
      <div className="cx-letter">
        <div className="cx-label">codex · this week</div>
        <p className="cx-verdict mute">{codex.line.replace(/^Codex · /, '')}</p>
      </div>
    )
  }
  const verdict = codexVerdict(codex)
  const threads = (codex.split?.threads ?? []).filter((thread) => thread.credits > 0)
  const [first, second] = threads
  return (
    <div className="cx-letter">
      <div className="cx-label">codex · this week</div>
      <div className="cx-row">
        <div className="cx-big">
          {codex.usedPercent === null || codex.status === 'stale' ? '–' : Math.round(codex.usedPercent)}
          <small>%</small>
        </div>
        <div>
          <p className="cx-verdict">
            <span className={verdict.tone}>{verdict.head}</span> {verdict.rest}
          </p>
          <div className="sub">
            {codex.resetsAt === null ? '' : `resets ${dayClock(codex.resetsAt)}, in ${days(codex.resetsAt - state.now)} · `}
            {codexRead(codex, frozen)}
          </div>
        </div>
      </div>
      {first ? (
        <p className="cx-body">
          <b className="who-name">{clip(first.title, 48)}</b> ate <b className="cmp">{share(first.share)}</b> of it
          {second ? (
            <>
              , <b className="who-name">{clip(second.title, 48)}</b> <b className="cmp">{share(second.share)}</b>
            </>
          ) : null}
          .{' '}
          <button type="button" className="link" onClick={() => jump('q-codex')}>
            the codex ledger ↓
          </button>
        </p>
      ) : null}
    </div>
  )
}

export function Letter({ state, frozen, focus }: { state: State; frozen: boolean; focus?: 'block' | 'week' | undefined }) {
  const five = state.fiveHour
  const block = state.block
  const fableName = state.fable?.model ?? 'Fable'
  const fable = state.week.fable
  const fableToday =
    fable && !fable.crossedReset
      ? (fable.delta ?? 0) > 0
        ? `moved ${Math.round(fable.delta ?? 0)} ${state.week.since === 'today' ? 'today' : 'in this window'}`
        : `nothing spent on it ${state.week.since === 'today' ? 'today' : 'in this window'}`
      : undefined

  const signoff = (
    <div className="signoff">
      <div className="sig">— tally</div>
      {five ? (frozen ? `Frozen at the meter reading of ${hm(five.sampledAt)}. ` : `Meters read at ${hm(five.sampledAt)}, ${ago(five.ageSeconds)}. `) : ''}
      Plain figures are read off a meter; <span className="cmp">underlined</span> ones are computed. Shares are good to
      about a quarter of each figure.{' '}
      <button type="button" className="link" onClick={() => jump('q-ground')}>
        What this stands on
      </button>
      .
    </div>
  )

  if (!five || !block) {
    return (
      <aside className="letter">
        <div className="dateline">{dateline(state.now)}</div>
        <p className="verdict mute">No meter reading in the log yet.</p>
        <p className="body">The sampler writes one every five minutes; the page fills in after the first.</p>
        {signoff}
      </aside>
    )
  }

  const weekly = state.week.weekly
  const week = focus === 'week'
  const bigPct = week ? (state.weekly?.pct ?? 0) : five.pct
  const bigSub: ReactNode = week ? (
    <>of the weekly allowance{state.weekly?.resetsAt ? <>, week to <b>{dayClock(state.weekly.resetsAt)}</b></> : null}</>
  ) : frozen ? (
    <>
      of the 5-hour block {hm(block.start)}–<b>{hm(block.resetsAt)}</b>
    </>
  ) : five.ended ? (
    <>
      the last block ended at {Math.round(block.endPct)}%;{' '}
      {five.nextResetsAt === null ? 'a new one opens with your next message' : `start now and it resets ${hm(five.nextResetsAt)}`}
    </>
  ) : (
    <>
      of the 5-hour block since {hm(block.start)} · resets <b>{hm(five.resetsAt)}</b>, in {until(five.resetsAt - state.now)}
    </>
  )

  const projection = block.projection
  let verdict: { tone: string; head: string; rest: ReactNode }
  if (frozen) verdict = { tone: '', head: `Stood at ${Math.round(bigPct)}%`, rest: `at the last reading, ${hm(five.sampledAt)}.` }
  else if (five.ended) verdict = { tone: 'ok', head: 'Fresh block.', rest: 'Nothing is eating it yet.' }
  else if (five.saturated || five.pct >= 100) verdict = { tone: 'bad', head: 'At the ceiling.', rest: `It lifts at ${hm(five.resetsAt)}.` }
  else if (projection.ready && projection.hitsHundredAt !== null)
    verdict = { tone: 'bad', head: `100% at ${hm(projection.hitsHundredAt)},`, rest: `before the ${hm(five.resetsAt)} reset.` }
  else if (projection.ready)
    verdict = {
      tone: 'ok',
      head: 'You make it,',
      rest: (
        <>
          <span className="cmp">about {Math.round(projection.pctAtReset)}%</span> at reset.
        </>
      ),
    }
  else verdict = { tone: 'mute', head: 'Too early to call.', rest: '' }

  const rows: Named[] = week
    ? (weekly && !weekly.crossedReset ? weekly.sessions : [])
        .filter((row) => row.share > 0)
        .map((row) => ({ name: sentenceName(row), share: row.share }))
    : (state.split?.sessions ?? []).filter((row) => row.share > 0).map((row) => ({ name: sentenceName(row), share: row.share }))

  return (
    <aside className="letter">
      <div className="dateline">{frozen ? `as it stood ${dateline(state.now)}` : dateline(state.now)}</div>
      {state.fiveHour?.expired && !frozen ? (
        <p className="stale">
          The block reset over ten minutes ago and nothing has read the account since, so this page is stale. Check{' '}
          <code>systemctl --user list-timers tally-sampler.timer</code>.
        </p>
      ) : null}
      <div className="big">
        {Math.round(bigPct)}
        <small>%</small>
      </div>
      <div className="big-sub">{bigSub}</div>
      <p className="verdict">
        <span className={verdict.tone}>{verdict.head}</span> <span className="rest">{verdict.rest}</span>
      </p>
      <p className="body">
        <AteSentence rows={rows} what={week ? 'the weekly movement' : five.ended && !frozen ? 'the last block' : 'it'} />
      </p>
      <div className="meters">
        {week ? (
          <MeterLine
            label="5-hour"
            pct={`${Math.round(five.pct)}%`}
            verdict="the block the week closed on"
            sub={`${hm(block.start)}–${hm(block.resetsAt)}`}
          />
        ) : (
          <WeeklyLine state={state} label="weekly" meter={state.weekly} />
        )}
        <WeeklyLine state={state} label={fableName} meter={state.fable} {...(fableToday ? { extra: fableToday } : {})} />
      </div>
      <CodexLetter state={state} frozen={frozen} />
      {signoff}
    </aside>
  )
}
