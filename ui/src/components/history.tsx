import { useEffect, useState } from 'react'
import {
  errorLine,
  fetchCodexHistory,
  fetchHistory,
  type BlockSummary,
  type ClaudeHistory,
  type CodexHistory,
  type WeekSummary,
} from '../api'
import { dayDate, dayKey, hm, money, pct, rate } from '../format'
import { blockHref, weekHref } from '../route'
import { ChatsShareChart, CodexRateChart, CostPerPercentChart } from './charts'

/**
 * the history overview: every 5-hour block and every weekly window since the
 * first meter sample, what each of them cost per meter point, and what the whole
 * thing is worth against the sub. click any window to see the page frozen at it.
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

  return (
    <>
      {history.since === null ? (
        <p className="warn">
          the meter log has no reading in it yet, so there is no history to draw. the sampler writes one every five
          minutes and this page starts at its first.
        </p>
      ) : (
        <>
          <div className="legend">
            <b>Real:</b> every meter reading and every reset time. <b>Computed from real:</b> the cost of each window
            and what a point of it cost. <b>Not shown:</b> anything before {dayDate(history.since)}, and any window
            the sampler did not measure — those are marked, never drawn as a zero.
          </div>
          {history.indexing ? (
            <p className="warn">
              the transcript index is still building, so every cost on this page may be missing requests.
            </p>
          ) : null}

          <SubValue history={history} />
          <Blocks blocks={history.blocks} weeks={history.weeks} />
          <Weeks weeks={history.weeks} />
          <CostPerPercentChart history={history} />
          <ChatsShareChart weeks={history.weeks} />
        </>
      )}

      {codexShown ? (
        <>
          <h2 style={{ marginTop: 52 }}>codex</h2>
          {codexError && !codex ? (
            <p className="warn">the codex history endpoint is not answering: {codexError}</p>
          ) : !codex ? (
            <p className="loading">reading the codex windows…</p>
          ) : (
            <CodexSection codex={codex} />
          )}
        </>
      ) : null}

      <p className="caveat">{history.caveat}</p>
    </>
  )
}

/** chart (b): what the sub bought this week and this month, against what it costs */
function SubValue({ history }: { history: ClaudeHistory }) {
  const { subValue } = history
  const share = Math.min(1, subValue.monthCost / Math.max(1, subValue.planUsd))
  return (
    <>
      <h2>what the sub is worth</h2>
      <p className="calc">
        {money(subValue.monthCost)} of list-price usage this month (since {dayDate(subValue.monthStart)}), against the{' '}
        {money(subValue.planUsd)} {subValue.planName} price · {money(subValue.weekCost)} in the week since{' '}
        {dayDate(subValue.weekStart)} {hm(subValue.weekStart)}
        <small>computed, no model</small>
      </p>
      <div className="meter sub">
        <i style={{ width: `${share * 100}%` }} />
      </div>
      <div className="stripcap">
        {subValue.monthCost >= subValue.planUsd
          ? `the bar is full at ${money(subValue.planUsd)}: the month is already ${(
              subValue.monthCost / subValue.planUsd
            ).toFixed(1)}× the price`
          : `${pct(share * 100)} of the ${money(subValue.planUsd)} ${subValue.planName} price the month has to beat`}
      </div>
    </>
  )
}

/** the opacity rule the lanes use, so a costly window reads brighter here too */
function brightness(cost: number, max: number): number {
  return 0.35 + 0.45 * Math.sqrt(Math.min(1, cost / Math.max(0.01, max)))
}

/** a day row runs midnight to 05:00 the next morning, so a block opened late still fits on its own day */
const AXIS_HOURS = 29

function hourOfDay(unix: number): number {
  const date = new Date(unix * 1000)
  return date.getHours() + date.getMinutes() / 60
}

/**
 * the block grid. with `weeks` it is cut at the weekly resets, the running week
 * open and every older one folded under a one-line summary, so the page stays one
 * screen tall however long the log gets.
 */
export function Blocks({ blocks, weeks, title }: { blocks: BlockSummary[]; weeks?: WeekSummary[]; title?: string }) {
  if (!blocks.length) return <p className="more">no 5-hour blocks in the log yet.</p>
  const max = Math.max(0.01, ...blocks.map((block) => block.usage.cost))
  // newest group first; a block belongs to the week whose window holds its start
  const groups: { key: string; week: WeekSummary | null; rows: BlockSummary[] }[] = []
  for (const block of [...blocks].reverse()) {
    const week = weeks?.find((one) => block.start >= one.start && block.start < one.resetsAt) ?? null
    const key = week ? `w${week.resetsAt}` : 'loose'
    const last = groups.at(-1)
    if (last && last.key === key) last.rows.unshift(block)
    else groups.push({ key, week, rows: [block] })
  }

  return (
    <>
      <h2 style={{ marginTop: 44 }}>{title ?? `every 5-hour block · ${blocks.length} since the first sample`}</h2>
      {groups.map((group, index) =>
        group.week === null || index === 0 ? (
          <DayRows key={group.key} blocks={group.rows} max={max} />
        ) : (
          <details className="fold" key={group.key}>
            <summary>
              week to {dayDate(group.week.resetsAt)} · {group.rows.length} blocks · {money(group.week.usage.cost)} · ended{' '}
              {pct(group.week.endPct)}
            </summary>
            <DayRows blocks={group.rows} max={max} />
          </details>
        ),
      )}
      <p className="caveat">
        Newest day first; a tile sits where its block ran on the clock and is five hours wide. Each tile is where the meter ended and how far it moved inside the block. The bar under it is the same ending
        percentage, its brightness is what the block cost. A block with no
        dollars-per-point figure had one sample, no movement, a sampler gap, or a meter already at 100%: the tile says
        so and the charts draw it as a cross.
      </p>
    </>
  )
}

function DayRows({ blocks, max }: { blocks: BlockSummary[]; max: number }) {
  const days: { key: string; at: number; rows: BlockSummary[] }[] = []
  for (const block of blocks) {
    const key = dayKey(block.start)
    const last = days.at(-1)
    if (last && last.key === key) last.rows.push(block)
    else days.push({ key, at: block.start, rows: [block] })
  }

  return (
    <>
      <div className="hday haxis" aria-hidden="true">
        <div />
        <div className="htrack">
          {[0, 6, 12, 18, 24].map((hour) => (
            <span key={hour} style={{ left: `${(hour / AXIS_HOURS) * 100}%` }}>
              {hour === 24 ? 'midnight' : `${String(hour).padStart(2, '0')}:00`}
            </span>
          ))}
        </div>
      </div>
      {[...days].reverse().map((day) => (
        <div className="hday" key={day.key}>
          <div className="hd">{dayDate(day.at)}</div>
          <div className="htrack">
            {day.rows.map((block) => (
              <a
                className={`tile at${block.measured ? '' : ' un'}`}
                key={block.resetKey}
                href={blockHref(block.resetKey)}
                style={{ left: `${(hourOfDay(block.start) / AXIS_HOURS) * 100}%` }}
                title={`${block.usage.requests} requests${block.measured ? '' : ' · no dollars per point from this one'}`}
              >
                <b>
                  {pct(block.endPct)}
                  {block.measured && block.delta !== null ? <small className="tdel">+{Math.round(block.delta)}</small> : null}
                </b>
                <span className="tmeta">
                  <em>
                    {hm(block.start)}–{hm(block.resetKey)}
                  </em>
                  <span>
                    {money(block.usage.cost)} · {block.usage.sessions} session{block.usage.sessions === 1 ? '' : 's'}
                    {' · '}
                    {block.measured && block.dollarsPerPercent !== null ? (
                      `${rate(block.dollarsPerPercent)}/pt`
                    ) : (
                      <i className="nd">not measured</i>
                    )}
                  </span>
                </span>
                <u className="tfill">
                  <i style={{ width: `${Math.min(100, block.endPct)}%`, opacity: brightness(block.usage.cost, max) }} />
                </u>
              </a>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function Weeks({ weeks }: { weeks: WeekSummary[] }) {
  if (!weeks.length) return null
  const max = Math.max(0.01, ...weeks.map((week) => week.usage.cost))
  return (
    <>
      <h2 style={{ marginTop: 44 }}>every weekly window</h2>
      <div className="htiles">
        {weeks.map((week) => (
          <a
            className="tile wide"
            key={week.resetsAt}
            href={weekHref(week.resetsAt)}
            title={`${dayDate(week.start)} to ${dayDate(week.end)} · ${money(week.usage.cost)} over ${
              week.usage.requests
            } requests${week.fable.model ? ` · ${week.fable.model} ${week.fable.endPct === null ? 'not read' : pct(week.fable.endPct)}` : ''}`}
          >
            <em>
              {dayDate(week.resetsAt)} {hm(week.resetsAt)}
              {week.partial ? ' · so far' : ''}
            </em>
            <b>{pct(week.endPct)}</b>
            <span>
              {week.chatsPercent === null ? <i className="nd">chats not measured</i> : `${pct(week.chatsPercent)} chats`}
              {' · '}
              {money(week.usage.cost)}
            </span>
            <span>
              {week.dollarsPerPercent === null ? (
                <i className="nd">no dollars per point</i>
              ) : (
                `${rate(week.dollarsPerPercent)}/pt`
              )}
              {week.fable.delta === null ? '' : ` · Fable ${Math.round(week.fable.delta)} pts`}
            </span>
            <u className="tfill">
              <i style={{ width: `${Math.min(100, week.endPct)}%`, opacity: brightness(week.usage.cost, max) }} />
            </u>
          </a>
        ))}
      </div>
    </>
  )
}

function CodexSection({ codex }: { codex: CodexHistory }) {
  const { subValue } = codex
  const unknown = subValue.unknownModels
  return (
    <>
      <p className="calc">
        {/* the priced subtotal is a real number even when a model is missing a price
            row, so it is drawn with the gap named beside it, never withheld */}
        {money(subValue.monthCostUsd ?? subValue.pricedMonthCostUsd)} of api list price this month (since{' '}
        {dayDate(subValue.monthStart)}), against the {money(subValue.planUsd)} {subValue.planName} tier
        {subValue.monthCostUsd === null ? ` · plus calls of ${unknown.join(', ')}, which have no price row` : ''}
        <small>computed, no model</small>
      </p>
      {unknown.length ? (
        <p className="warn">
          {unknown.length === 1 ? 'a model is' : `${unknown.length} models are`} not on the price table, so the figure
          above is short by whatever {unknown.length === 1 ? 'it' : 'they'} cost: <code>{unknown.join(', ')}</code>
        </p>
      ) : null}
      <CodexRateChart windows={codex.windows} now={codex.now} />
      <p className="caveat">
        Credits come from OpenAI's Codex rate card and the meter readings kept since 15 Sep 2026; prices from{' '}
        {codex.prices.source}, read {codex.prices.readAt}.
      </p>
    </>
  )
}
