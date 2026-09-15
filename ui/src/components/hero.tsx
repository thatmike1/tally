import { useEffect, useState } from 'react'
import type { State } from '../api'
import { ago, dayClock, hm, pct, until } from '../format'

/** the one big number, its reset, the projection verdict, and the two weekly bars */
export function Hero({ state }: { state: State }) {
  const [takeaway, setTakeaway] = useState<string | null>(null)

  // the server refreshes the text on its own minute tick and the route only
  // reads memory, so every state poll asks again rather than waiting for a new sample
  useEffect(() => {
    let alive = true
    fetch('/api/takeaway')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { text: string | null; model: string | null } | null) => {
        if (alive && data?.text) {
          setTakeaway(data.text)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [state.now])

  const five = state.fiveHour
  if (!five || !state.block) return <p className="loading">no api meter sample in the log yet.</p>
  const projection = state.block.projection
  const hasPace = state.block.to > state.block.from && !five.ended
  const over = projection.hitsHundredAt !== null

  return (
    <>
      <div className="hero">
        <div className="big">
          {pct(five.pct)}
          <small>
            {five.ended
              ? `5-hour block · reset at ${hm(five.resetsAt)} · read ${ago(five.ageSeconds)}`
              : `5-hour block · resets ${hm(five.resetsAt)}, in ${until(five.resetsAt - state.now)} · read ${ago(five.ageSeconds)}`}
          </small>
        </div>
        <div className="verdict">
          {five.ended ? (
            <>
              <b>fresh block</b> · the last one ended at {pct(state.block.endPct)}
              <span>your next message opens a new 5-hour block</span>
            </>
          ) : !hasPace ? (
            <>
              <b>no pace yet</b>
              <span>one sample in this block so far</span>
            </>
          ) : over ? (
            <>
              <b className="over">100% at {hm(projection.hitsHundredAt!)}</b>
              <span>at this block's pace</span>
            </>
          ) : (
            <>
              <b>you make it</b> · ≈ {pct(projection.pctAtReset)} at reset
              <span>at this block's pace</span>
            </>
          )}
          {takeaway ? <div className="takeaway">{takeaway}</div> : null}
        </div>
        <div className="wk">
          <WeeklyBar label="weekly" meter={state.weekly} />
          <WeeklyBar label={state.fable?.model ?? 'Fable'} meter={state.fable} />
        </div>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.min(100, five.pct)}%` }} />
        {hasPace && projection.pctAtReset > five.pct ? (
          <u style={{ left: `${five.pct}%`, width: `${Math.min(100, projection.pctAtReset) - five.pct}%` }} />
        ) : null}
      </div>
    </>
  )
}

function WeeklyBar({ label, meter }: { label: string; meter: State['weekly'] }) {
  if (!meter) return null
  const verdict = meter.verdict
  const tone = verdict?.phrase === 'over pace' ? 'over' : verdict?.phrase === 'on pace' ? 'n' : ''
  return (
    <>
      <div className="l">{label}</div>
      <div className="b">
        <i style={{ width: `${Math.min(100, meter.pct)}%` }} />
      </div>
      <div className="p">{pct(meter.pct)}</div>
      <div className={`v ${tone}`}>
        {verdict?.phrase}
        {meter.resetsAt ? ` · ${dayClock(meter.resetsAt)}` : ''}
      </div>
    </>
  )
}
