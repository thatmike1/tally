import { useEffect, useState } from 'react'
import { fetchState, type State } from './api'
import { Day } from './components/day'
import { Hero } from './components/hero'
import { BlockSplit } from './components/split'
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

  useEffect(() => {
    let alive = true
    let first = true
    const load = async () => {
      try {
        // only the first load moves the "last looked" marker
        const next = await fetchState(!first)
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
        titles. <b>Computed from real:</b> the split, the projection, the weekly verdicts.{' '}
        <b>Not shown:</b> points for any stretch the sampler did not measure.
        {state.fiveHour ? ` Meter read ${ago(state.fiveHour.ageSeconds)}.` : ''}
      </div>
      {state.fiveHour?.expired ? (
        <p className="warn">
          the newest sample belongs to a block that has already reset: the sampler is behind, so this page is stale.
          check <code>systemctl --user list-timers usage-sample.timer</code>.
        </p>
      ) : null}
      {state.notes.map((note) => (
        <p className="warn" key={note}>
          {note}
        </p>
      ))}
      <Hero state={state} />
      <BlockSplit state={state} />
      <Day state={state} />
    </>
  )
}
