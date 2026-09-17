import { useEffect, useState } from 'react'
import type { State, WeekMode } from '../api'
import { ago } from '../format'
import { Codex, CodexThreads } from './codex'
import { Day } from './day'
import { Hero } from './hero'
import { BlockSplit } from './split'
import { Week } from './week'

/** past this width Codex gets its own column beside the Claude page */
const WIDE_QUERY = '(min-width: 1900px)'

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY)
    const update = () => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

/**
 * the whole page for one state: live at `#/`, or frozen at a past window in the
 * history drill-in. a frozen page has no week-mode buttons (the server answers
 * `?at=` with the whole window) and asks for no takeaway, since the model would
 * be writing a line about right now over a picture of last Tuesday.
 */
export function PageBody({
  state,
  weekMode,
  onWeekMode,
  frozen = false,
}: {
  state: State
  weekMode: WeekMode
  onWeekMode?: (mode: WeekMode) => void
  frozen?: boolean
}) {
  const wide = useWide()
  return (
    <>
      <div className="legend">
        <b>Real:</b> the meters, the day's meter line, every reset time, the lanes, the other agents' titles.{' '}
        <b>Computed from real:</b> the splits, the projection, the weekly verdicts.{' '}
        <b>Not shown:</b> points for any stretch the sampler did not measure.
        {state.fiveHour && !frozen ? ` Meter read ${ago(state.fiveHour.ageSeconds)}.` : ''}
      </div>
      {state.index.building ? (
        <p className="warn">
          the transcript index is building ({state.index.done} of {state.index.total} files
          {state.index.cold ? ', first run' : ''}). the lanes and the split read the tree directly until it catches
          up.
        </p>
      ) : null}
      {state.index.failed > 0 ? (
        <p className="warn">
          {state.index.failed} {state.index.failed === 1 ? 'file' : 'files'} could not be read, so the index is
          missing them; every pass tries again.
        </p>
      ) : null}
      {state.fiveHour?.expired && !frozen ? (
        <p className="warn">
          the block reset over ten minutes ago and nothing has read the account since: the sampler is behind, so this
          page is stale. check <code>systemctl --user list-timers usage-sample.timer</code>.
        </p>
      ) : null}
      {state.notes.map((note) => (
        <p className="warn" key={note}>
          {note}
        </p>
      ))}
      {wide ? (
        <div className="columns">
          <main>
            <Hero state={state} frozen={frozen} />
            <BlockSplit state={state} />
            <Week state={state} mode={weekMode} {...(onWeekMode ? { onMode: onWeekMode } : {})} />
            <Day state={state} />
          </main>
          <aside className="codex-col">
            <Codex state={state} frozen={frozen} />
            <CodexThreads state={state} beside />
          </aside>
        </div>
      ) : (
        <>
          <Hero state={state} frozen={frozen} />
          <Codex state={state} frozen={frozen} />
          <BlockSplit state={state} />
          <Week state={state} mode={weekMode} {...(onWeekMode ? { onMode: onWeekMode } : {})} />
          <CodexThreads state={state} />
          <Day state={state} />
        </>
      )}
    </>
  )
}
