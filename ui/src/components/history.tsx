import { useEffect, useState, type ReactNode } from 'react'
import {
  errorLine,
  fetchCodexHistory,
  fetchHistory,
  type BlockSummary,
  type ClaudeHistory,
  type CodexHistory,
  type WeekSummary,
} from '../api'
import { dayDate, hm, money, pct, rate } from '../format'
import { blockHref, weekHref } from '../route'
import { ChatsShareChart, CodexRateChart, CostPerPercentChart } from './charts'
import {
  blockLine,
  byDay,
  dayLead,
  finishedWeeks,
  inWeek,
  longDay,
  planVerdict,
  pointRange,
  ranFull,
  weekLead,
} from './history-words'
import { Question, Statement } from './ledger'
import { modelName } from './words'

/**
 * the history page in the answer page's form: the letter on the left is the
 * month against the plan with one line per week, the column on the right holds
 * what a point costs and then every day, this week's days open and older weeks
 * folded into a sentence per day. every block links to the page frozen at it.
 */
export function History() {
  const [history, setHistory] = useState<ClaudeHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [codex, setCodex] = useState<CodexHistory | null>(null)
  const [codexError, setCodexError] = useState<string | null>(null)

  // history is retrospective, so it loads once: nothing here moves while you read it
  useEffect(() => {
    let alive = true
    fetchHistory()
      .then((answer) => alive && setHistory(answer))
      .catch((problem: unknown) => alive && setError(errorLine(problem)))
    fetchCodexHistory()
      .then((answer) => alive && setCodex(answer))
      .catch((problem: unknown) => alive && setCodexError(errorLine(problem)))
    return () => {
      alive = false
    }
  }, [])

  if (error && !history) {
    return (
      <>
        <p className="warn">the history endpoint is not answering: {error}</p>
        <p className="more">
          <a href="#/">back to today</a>
        </p>
      </>
    )
  }
  if (!history) return <p className="loading">reading the windows…</p>

  // a Codex the machine does not have is not an empty section, it is no section
  const codexShown = !codex || codex.installed
  const since = history.since

  return (
    <div className="answer">
      <HistoryLetter history={history} codex={codexShown ? codex : null} />
      <main className="rows">
        {since === null ? (
          <Question
            id="h-empty"
            title="Nothing to read yet"
            lead="The meter log has no reading in it, so there is no history to draw. The sampler writes one every five minutes and this page starts at its first."
          >
            {null}
          </Question>
        ) : (
          <>
            <PointCost history={history} />
            <Days history={history} />
            <Chats weeks={history.weeks} />
          </>
        )}
        {codexShown ? <CodexWeeks codex={codex} error={codexError} /> : null}
        <Ground history={history} />
        <div className="coda">
          <span className="say">Back to the block that is running.</span>
          <a className="go" href="#/">
            today →
          </a>
        </div>
      </main>
    </div>
  )
}

/** `to Sun 18`: a week line's label, short enough for the letter's first column */
function weekLabel(week: WeekSummary): string {
  return week.partial ? 'this week' : `to ${dayDate(week.resetsAt).split(' ').slice(0, 2).join(' ')}`
}

/** the left panel: the month against the plan, the weeks as verdict lines, Codex last */
function HistoryLetter({ history, codex }: { history: ClaudeHistory; codex: CodexHistory | null }) {
  const { subValue } = history
  const weeks = [...history.weeks].reverse()
  const current = weeks.find((week) => week.partial) ?? null
  const verdict = planVerdict(subValue)
  const full = history.blocks.filter(ranFull).length
  const codexMonth = codex ? (codex.subValue.monthCostUsd ?? codex.subValue.pricedMonthCostUsd) : null

  return (
    <aside className="letter">
      <div className="dateline">
        {history.since === null ? 'no meter reading yet' : `since ${longDay(history.since)}, the first meter reading`}
      </div>
      {history.indexing ? (
        <p className="stale">The transcript index is still building, so every cost on this page may be missing requests.</p>
      ) : null}
      <div className="big">
        {(subValue.monthCost / Math.max(1, subValue.planUsd)).toFixed(1)}
        <small>×</small>
      </div>
      <div className="big-sub">
        the {money(subValue.planUsd)} {subValue.planName} plan, in list-price use this month:{' '}
        <b>{money(subValue.monthCost)}</b> since {dayDate(subValue.monthStart)}
      </div>
      <p className="verdict">
        <span className={verdict.tone}>{verdict.head}</span>{' '}
        <span className="rest">
          {verdict.rest}
          {current ? `${verdict.rest ? ' ' : ''}This week is at ${pct(current.endPct)} on ${money(current.usage.cost)}.` : ''}
        </span>
      </p>
      <p className="body">
        {finishedWeeks(history.weeks)}{' '}
        {history.blocks.length ? `${full} of ${history.blocks.length} blocks ran into 100%.` : ''}
      </p>
      <div className="meters">
        {weeks.map((week) => (
          <a className="mline" key={week.resetsAt} href={weekHref(week.resetsAt)}>
            <span className="mn">{weekLabel(week)}</span>
            <span className="mp">{pct(week.endPct)}</span>
            <span className="mv">
              {week.fable.endPct === null
                ? 'Fable not read'
                : `${week.fable.model ? modelName(week.fable.model) : 'Fable'} ${pct(week.fable.endPct)}`}{' '}
              · {money(week.usage.cost)}
              <span className="sub">
                {week.dollarsPerPercent === null ? (
                  'price per point not measured'
                ) : (
                  <>
                    <span className="cmp">{rate(week.dollarsPerPercent)}</span> a weekly point
                  </>
                )}
                {' · '}
                {week.chatsPercent === null ? 'Chats not measured' : `Chats ${pct(week.chatsPercent)}`}
              </span>
            </span>
          </a>
        ))}
        {codex && codexMonth !== null ? (
          <div className="mline">
            <span className="mn">Codex</span>
            <span className="mp">{money(codexMonth)}</span>
            <span className="mv">
              OpenAI list price this month vs {money(codex.subValue.planUsd)}
              <span className="sub">
                {codex.subValue.unknownModels.length
                  ? `a floor: ${codex.subValue.unknownModels.join(', ')} has no price row`
                  : codex.subValue.planName}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <div className="signoff">
        <div className="sig">— tally</div>
        {history.since === null ? '' : `Nothing before ${dayDate(history.since)} is shown. `}A window the sampler did not
        measure says so; it is never drawn as a zero. Plain figures are read off a meter;{' '}
        <span className="cmp">underlined</span> ones are computed.
      </div>
    </aside>
  )
}

function PointCost({ history }: { history: ClaudeHistory }) {
  const range = pointRange(history.blocks)
  const weeks = history.weeks.filter((week) => week.dollarsPerPercent !== null)
  const [last, before] = [...weeks].reverse()
  return (
    <Question
      id="h-cost"
      title="What a point costs"
      lead={
        <>
          {range ? (
            <>
              A 5-hour point has cost between <b>{rate(range.min)}</b> and <b>{rate(range.max)}</b> of list price,{' '}
              <span className="cmp">{rate(range.middle)}</span> in the middle, over {range.count} measured blocks.
            </>
          ) : (
            'No 5-hour block has been measured yet, so a point has no price.'
          )}{' '}
          {last ? (
            <>
              A weekly point cost <span className="cmp">{rate(last.dollarsPerPercent!)}</span> in the week to{' '}
              {dayDate(last.resetsAt)}
              {before ? <>, against {rate(before.dollarsPerPercent!)} the week before</> : null}.
            </>
          ) : null}
        </>
      }
      aside={
        <p className="aside">
          A 5-hour point and a weekly point are different sizes, so they get separate panels. Crosses are windows with
          no measured price, never zeros.
        </p>
      }
    >
      <CostPerPercentChart history={history} />
    </Question>
  )
}

/** one block as a small letter: where the meter ended, how far it moved, one sentence; opens the frozen page */
function BlockLetter({ block }: { block: BlockSummary }) {
  const line = blockLine(block)
  const time = `${hm(block.start)}–${hm(block.resetKey)}`
  if (line.idle) {
    return (
      <a className="blk idle" href={blockHref(block.resetKey)}>
        <span className="bn">{pct(block.endPct)}</span>
        <span className="bt">{time}</span>
        <span className="bs">{line.text}</span>
      </a>
    )
  }
  return (
    <a className={block.ended ? 'blk' : 'blk cur'} href={blockHref(block.resetKey)}>
      <span className={ranFull(block) ? 'bn bad' : 'bn'}>
        {pct(block.endPct)}
        {block.delta !== null ? <small>+{Math.round(block.delta)}</small> : null}
      </span>
      <span className="bt">
        {time}
        {block.ended ? '' : ' · running now'}
      </span>
      <span className="bs">
        {line.text}
        {line.perPoint !== null ? (
          <>
            ; <span className="cmp">{rate(line.perPoint)}</span> a point.
          </>
        ) : null}
      </span>
    </a>
  )
}

/** a day's blocks side by side, oldest first */
export function BlockLetters({ blocks }: { blocks: BlockSummary[] }) {
  return (
    <div className="blocks">
      {blocks.map((block) => (
        <BlockLetter key={block.resetKey} block={block} />
      ))}
    </div>
  )
}

/** day statements for a run of blocks, newest day first; each opens into its block letters */
export function DayStatements({ blocks }: { blocks: BlockSummary[] }) {
  return (
    <>
      {byDay(blocks).map((day) => (
        <Statement
          key={day.key}
          line={
            <>
              <b>{longDay(day.at)}</b> <span className="st-sub">{dayLead(day.blocks)}</span>
            </>
          }
        >
          <BlockLetters blocks={day.blocks} />
        </Statement>
      ))}
    </>
  )
}

/**
 * this week's days as questions of their own, newest first; every older week as
 * one question with a statement per day. blocks before the first weekly window
 * close the list.
 */
function Days({ history }: { history: ClaudeHistory }) {
  const weeks = [...history.weeks].reverse()
  const [current, ...older] = weeks[0]?.partial ? weeks : [null, ...weeks]
  const sections: ReactNode[] = []
  if (current) {
    for (const day of byDay(inWeek(history.blocks, current))) {
      sections.push(
        <Question key={day.key} id={`d-${day.key}`} title={longDay(day.at)} lead={dayLead(day.blocks)}>
          <BlockLetters blocks={day.blocks} />
        </Question>,
      )
    }
  }
  for (const week of older) {
    if (!week) continue
    const blocks = inWeek(history.blocks, week)
    sections.push(
      <Question
        key={week.resetsAt}
        id={`w-${week.resetsAt}`}
        title={`the week to ${longDay(week.resetsAt)}`}
        lead={weekLead(week, blocks)}
        aside={
          <a className="go-link" href={weekHref(week.resetsAt)}>
            the page as the week closed →
          </a>
        }
      >
        {blocks.length ? <DayStatements blocks={blocks} /> : <p className="mute">No block in the log for this week.</p>}
      </Question>,
    )
  }
  const first = history.weeks[0]
  const loose = first ? history.blocks.filter((block) => block.start < first.start) : []
  if (loose.length) {
    sections.push(
      <Question key="loose" id="d-loose" title="before the first weekly window" lead={dayLead(loose)}>
        <DayStatements blocks={loose} />
      </Question>,
    )
  }
  if (!sections.length) {
    sections.push(
      <Question key="none" id="d-none" title="No blocks yet" lead="The log has no 5-hour block in it yet.">
        {null}
      </Question>,
    )
  }
  return <>{sections}</>
}

function Chats({ weeks }: { weeks: WeekSummary[] }) {
  if (!weeks.length) return null
  const known = weeks.filter((week) => week.chatsPercent !== null)
  const latest = known.at(-1)
  return (
    <Question
      id="h-chats"
      title="How much of the week was Chats"
      lead={
        latest ? (
          <>
            Chats leave no transcript here, so their share is taken off the weekly meter before a point is priced. The
            week to {dayDate(latest.resetsAt)} was <b>{pct(latest.chatsPercent!)}</b> Chats.
          </>
        ) : (
          'Chats leave no transcript here, and no week has a breakdown yet, so none of them has a Chats share.'
        )
      }
      aside={
        <p className="aside">
          From the last <code>seven_day_breakdown</code> before each reset, kept since 14 Sep 2026; an earlier week has
          no breakdown and is drawn as an empty column, not a zero.
        </p>
      }
    >
      <ChatsShareChart weeks={weeks} />
    </Question>
  )
}

function CodexWeeks({ codex, error }: { codex: CodexHistory | null; error: string | null }) {
  if (!codex) {
    return (
      <Question id="h-codex" title="What a Codex point costs" lead={error ? `The codex history endpoint is not answering: ${error}` : 'Reading the codex windows…'}>
        {null}
      </Question>
    )
  }
  const { subValue } = codex
  const unknown = subValue.unknownModels
  const measured = codex.windows.filter((window) => window.creditsPerPercent !== null)
  const last = measured.at(-1)
  return (
    <Question
      id="h-codex"
      title="What a Codex point costs"
      lead={
        <>
          {/* the priced subtotal is a real number even when a model is missing a price
              row, so it is drawn with the gap named beside it, never withheld */}
          <b>{money(subValue.monthCostUsd ?? subValue.pricedMonthCostUsd)}</b> of API list price this month, against
          the {money(subValue.planUsd)} {subValue.planName} tier
          {subValue.monthCostUsd === null ? `, plus calls of ${unknown.join(', ')}, which have no price row` : ''}.
          {last ? (
            <>
              {' '}
              The week to {dayDate(last.resetsAt)} ran a point at{' '}
              <span className="cmp">{Math.round(last.creditsPerPercent!).toLocaleString('en-US')}</span> credits.
            </>
          ) : null}
        </>
      }
      aside={
        <p className="aside">
          Credits come from OpenAI's Codex rate card and the meter readings kept since 15 Sep 2026; prices from{' '}
          {codex.prices.source}, read {codex.prices.readAt}. Fast-mode prices are applied per call; calls without a
          recorded speed use standard-rate estimates.
        </p>
      }
    >
      {unknown.length ? (
        <p className="warn">
          {unknown.length === 1 ? 'A model is' : `${unknown.length} models are`} not on the price table, so the month is
          short by whatever {unknown.length === 1 ? 'it' : 'they'} cost: <code>{unknown.join(', ')}</code>
        </p>
      ) : null}
      <CodexRateChart windows={codex.windows} now={codex.now} />
    </Question>
  )
}

/** what the history stands on, in the answer page's closing form */
function Ground({ history }: { history: ClaudeHistory }) {
  return (
    <Question
      id="q-ground"
      title="What this stands on"
      lead="Every figure here is either read off a meter or worked out from one. Here is which, and what the page leaves out."
    >
      <Statement line={<><b>Measured:</b> every meter reading and every reset time</>}>
        <dl className="kv">
          <dt>meters</dt>
          <dd>{history.sources.limits}</dd>
          <dt>breakdown</dt>
          <dd>{history.sources.usageRaw}</dd>
          <dt>index</dt>
          <dd>{history.sources.index}</dd>
        </dl>
      </Statement>
      <Statement line={<><b>Computed:</b> each window's list-price cost and what a point of it cost</>}>
        <p>{history.caveat}</p>
      </Statement>
      <Statement
        line={
          <>
            <b>Not shown:</b> anything before {history.since === null ? 'the first reading' : dayDate(history.since)}, and
            any window the sampler did not measure
          </>
        }
      >
        <p>
          A block with no price per point had one reading, no movement, a sampler gap over 20 minutes, or a meter already
          at 100%. Its line says which, and the charts draw it as a cross on the axis.
        </p>
      </Statement>
    </Question>
  )
}
