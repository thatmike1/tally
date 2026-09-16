import { useEffect, useRef, useState } from 'react'
import { errorLine, fetchState, type State, type WeekMode } from '../api'
import { PageBody } from './page'

const POLL_MS = 60_000

/** the live page at `#/`: the minute poll, the reset catch-up, the week mode */
export function Today() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [weekMode, setWeekMode] = useState<WeekMode>(() =>
    localStorage.getItem('tally-week') === 'whole' ? 'whole' : 'recent',
  )
  // the minute poll reads the mode through a ref so it keeps one timer
  const weekModeRef = useRef(weekMode)

  // the minute poll can land up to a minute after a reset; ask again right when it happens
  const resetsAt = state?.fiveHour && !state.fiveHour.ended ? state.fiveHour.resetsAt : null
  useEffect(() => {
    if (resetsAt === null) return
    const wait = resetsAt * 1000 - Date.now() + 2000
    if (wait <= 0 || wait > 6 * 3600_000) return
    const timer = setTimeout(() => {
      fetchState(true, weekModeRef.current)
        .then(setState)
        .catch(() => {})
    }, wait)
    return () => clearTimeout(timer)
  }, [resetsAt])

  useEffect(() => {
    let alive = true
    let first = true
    const load = async () => {
      try {
        // only the first load moves the "last looked" marker
        const next = await fetchState(!first, weekModeRef.current)
        first = false
        if (alive) {
          setState(next)
          setError(null)
        }
      } catch (problem) {
        if (alive) setError(errorLine(problem))
      }
    }
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const changeWeekMode = (mode: WeekMode) => {
    weekModeRef.current = mode
    localStorage.setItem('tally-week', mode)
    setWeekMode(mode)
    fetchState(true, mode)
      .then(setState)
      .catch(() => {})
  }

  if (error && !state) return <p className="warn">tally: {error}</p>
  if (!state) return <p className="loading">reading the meters…</p>
  return <PageBody state={state} weekMode={weekMode} onWeekMode={changeWeekMode} />
}
