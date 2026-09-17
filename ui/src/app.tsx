import { useEffect, useState } from 'react'
import { Frozen } from './components/frozen'
import { History } from './components/history'
import { Session } from './components/session'
import { Today } from './components/today'
import { parseRoute, type Route } from './route'

/** the hash is the router; `route.ts` holds the parsing, this holds the switch */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return route
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('tally-theme') ?? 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tally-theme', theme)
  }, [theme])
  return [theme, () => setTheme((current) => (current === 'light' ? 'dark' : 'light'))]
}

function Nav({ route }: { route: Route }) {
  const onHistory = route.kind === 'history'
  return (
    <nav className="nav">
      <a href="#/" aria-current={route.kind === 'today' ? 'page' : undefined}>
        today
      </a>
      <a href="#/history" aria-current={onHistory ? 'page' : undefined}>
        history
      </a>
      {route.kind === 'block' || route.kind === 'week' ? <span className="here">this window</span> : null}
      {route.kind === 'session' ? <span className="here">this session</span> : null}
    </nav>
  )
}

export function App() {
  const [theme, toggleTheme] = useTheme()
  const route = useRoute()

  return (
    <>
      <div className="top">
        <h1>tally</h1>
        <Nav route={route} />
        <button className="toggle" onClick={toggleTheme}>
          {theme === 'light' ? 'dark' : 'light'}
        </button>
      </div>
      {route.kind === 'history' ? (
        <History />
      ) : route.kind === 'block' ? (
        // keyed on the route so a hash change between two windows remounts: without
        // it the previous window's banner and frozen page stay up under the new key
        <Frozen key={`block-${route.resetKey}`} kind="block" resetKey={route.resetKey} />
      ) : route.kind === 'week' ? (
        <Frozen key={`week-${route.resetsAt}`} kind="week" resetKey={route.resetsAt} />
      ) : route.kind === 'session' ? (
        <Session key={`${route.id}@${route.at ?? 'live'}`} id={route.id} at={route.at} />
      ) : (
        <Today />
      )}
    </>
  )
}
