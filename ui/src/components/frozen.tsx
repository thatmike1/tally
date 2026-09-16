import { useEffect, useState } from 'react'
import {
  errorLine,
  fetchHistory,
  fetchStateAt,
  type BlockSummary,
  type State,
  type WeekSummary,
  type WindowUsage,
} from '../api'
import { dayDate, hm, money, pct, rate, ratio, tokens } from '../format'
import { PageBody } from './page'

/**
 * the drill-in: today's page, frozen at the last meter sample of a past window.
 *
 * the server answers `/api/state?at=<to>` with the whole page as it stood then,
 * so nothing here re-implements the hero, the split or the lanes — it fetches
 * once, never polls, and hands the same components a different instant.
 */
export function Frozen({ kind, resetKey }: { kind: 'block' | 'week'; resetKey: number }) {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [block, setBlock] = useState<BlockSummary | null>(null)
  const [week, setWeek] = useState<WeekSummary | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const run = async () => {
      // the window's last sample is where the page is frozen; without the history
      // answer the reset itself is the closest instant inside the window we know
      let at = resetKey - 1
      try {
        const history = await fetchHistory()
        if (!alive) return
        if (kind === 'block') {
          const found = history.blocks.find((one) => one.resetKey === resetKey) ?? null
          setBlock(found)
          if (found) at = found.to
        } else {
          const found = history.weeks.find((one) => one.resetsAt === resetKey) ?? null
          setWeek(found)
          if (found) at = found.to
        }
      } catch (problem) {
        if (!alive) return
        setHistoryError(errorLine(problem))
      }
      try {
        const answer = await fetchStateAt(at)
        if (alive) setState(answer)
      } catch (problem) {
        if (alive) setError(errorLine(problem))
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [kind, resetKey])

  return (
    <>
      <div className="frozen">
        <div className="fz-title">
          {block ? (
            <>
              5-hour block · {dayDate(block.start)} {hm(block.start)}–{hm(block.resetKey)}
            </>
          ) : week ? (
            <>
              week to {dayDate(week.resetsAt)} {hm(week.resetsAt)}
              {week.partial ? ' · still running' : ''}
            </>
          ) : (
            <>
              {kind === 'block' ? '5-hour block' : 'week'} · {dayDate(resetKey)} {hm(resetKey)}
            </>
          )}
          <a href="#/history">back to the overview</a>
        </div>
        {block ? <BlockLine block={block} /> : week ? <WeekLine week={week} /> : null}
        {historyError ? (
          <div className="fz-note warn">
            the history endpoint is not answering ({historyError}), so this window has no summary line; the page below
            is still frozen at {hm(resetKey)}.
          </div>
        ) : !block && !week ? (
          <div className="fz-note warn">no window with this key is in the history answer.</div>
        ) : null}
        <div className="fz-note">
          Every number below is this window's, read at the meter sample it closed on. Nothing on it is live.
        </div>
      </div>
      {error ? <p className="warn">tally: {error}</p> : null}
      {state ? <PageBody state={state} weekMode="whole" frozen /> : error ? null : <p className="loading">reading the window…</p>}
    </>
  )
}

function BlockLine({ block }: { block: BlockSummary }) {
  return (
    <div className="fz-line">
      ended <b>{pct(block.endPct)}</b>
      {block.delta === null ? (
        <> · <span className="nd">movement not measured</span></>
      ) : (
        <> · {Math.round(block.delta)} points from {pct(block.startPct)}</>
      )}
      {' · '}
      {money(block.usage.cost)} over {block.usage.requests} requests in {block.usage.sessions} session
      {block.usage.sessions === 1 ? '' : 's'}
      {block.measured && block.dollarsPerPercent !== null ? (
        <> · <b>{rate(block.dollarsPerPercent)}</b> a point</>
      ) : (
        <> · <span className="nd">no dollars per point from this one</span></>
      )}
      <CacheLine usage={block.usage} />
    </div>
  )
}

function WeekLine({ week }: { week: WeekSummary }) {
  return (
    <div className="fz-line">
      ended <b>{pct(week.endPct)}</b>
      {week.delta === null ? (
        <> · <span className="nd">movement not measured</span></>
      ) : (
        <> · {Math.round(week.delta)} points from {pct(week.startPct)}</>
      )}
      {week.chatsPercent === null ? (
        <> · <span className="nd">chats share not measured</span></>
      ) : (
        <> · {pct(week.chatsPercent)} of it Chats</>
      )}
      {' · '}
      {money(week.usage.cost)} over {week.usage.requests} requests
      {week.dollarsPerPercent === null ? (
        <> · <span className="nd">no dollars per point</span></>
      ) : (
        <> · <b>{rate(week.dollarsPerPercent)}</b> a point, Chats taken out</>
      )}
      {week.fable.delta === null ? null : (
        <>
          {' · '}
          {week.fable.model ?? 'Fable'} {Math.round(week.fable.delta)} points for {money(week.fable.cost)}
        </>
      )}
      <CacheLine usage={week.usage} />
    </div>
  )
}

/** the one small cache line per window: read against uncached input, write against read */
function CacheLine({ usage }: { usage: WindowUsage }) {
  return (
    <div className="fz-cache">
      cache: reads {ratio(usage.cache.readVsInput)} the uncached input, writes {ratio(usage.cache.writeVsRead)} the
      reads · {tokens(usage.tokens.cr)} read, {tokens(usage.tokens.cw1h + usage.tokens.cw5m)} written,{' '}
      {tokens(usage.tokens.in)} uncached in, {tokens(usage.tokens.out)} out
      {usage.unpriced ? ' · a request in this window had no price row, so the cost is a floor' : ''}
    </div>
  )
}
