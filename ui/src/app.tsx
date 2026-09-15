import { useEffect, useRef, useState } from 'react'
import { fetchState, type State, type WeekMode } from './api'
import { Day } from './components/day'
import { Hero } from './components/hero'
import { Codex, CodexThreads } from './components/codex'
import { BlockSplit } from './components/split'
import { Week } from './components/week'
import { ago } from './format'

const POLL_MS = 60_000

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('tally-theme') ?? 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tally-theme', theme)
  }, [theme])
  return [theme, () => setTheme((current) => (current === 'light' ? 'dark' : 'light'))]
}

export function App() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [theme, toggleTheme] = useTheme()
  const [weekMode, setWeekMode] = useState<WeekMode>(() => (localStorage.getItem('tally-week') === 'whole' ? 'whole' : 'recent'))
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
        if (alive) setError(problem instanceof Error ? problem.message : String(problem))
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

  return (
    <>
      <div className="top">
        <h1>tally</h1>
        <button className="toggle" onClick={toggleTheme}>
          {theme === 'light' ? 'dark' : 'light'}
        </button>
      </div>
      <div className="legend">
        <b>Real:</b> the meters, the day's meter line, every reset time, the lanes (cc-browse), the other agents'
        titles. <b>Computed from real:</b> the splits, the projection, the weekly verdicts.{' '}
        <b>Not shown:</b> points for any stretch the sampler did not measure.
        {state.fiveHour ? ` Meter read ${ago(state.fiveHour.ageSeconds)}.` : ''}
      </div>
      {state.fiveHour?.expired ? (
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
      <Hero state={state} />
      <Codex state={state} />
      <BlockSplit state={state} />
      <Week state={state} mode={weekMode} onMode={changeWeekMode} />
      <CodexThreads state={state} />
      <Day state={state} />
    </>
  )
}
