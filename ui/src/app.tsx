import { useEffect, useRef, useState } from 'react'
import { Frozen } from './components/frozen'
import { History } from './components/history'
import { Session } from './components/session'
import { Timeline } from './components/timeline'
import { Today } from './components/today'
import { parseRoute, routeHref, type PageRoute, type Route } from './route'

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

/**
 * a session opens as a drawer over the page it was opened from, so that page
 * never unmounts and keeps its scroll. `base` is the last route that was a page;
 * a session hash opened cold (a deep link) sits over today.
 */
function useBase(route: Route): PageRoute {
  const base = useRef<PageRoute>({ kind: 'today' })
  if (route.kind !== 'session') base.current = route
  return base.current
}

function Drawer({ base, children }: { base: PageRoute; children: React.ReactNode }) {
  const close = () => {
    window.location.hash = routeHref(base)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    // the page under the drawer stays put while the drawer scrolls
    document.body.classList.add('drawer-open')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('drawer-open')
    }
  })
  return (
    <div className="drawer-back" onClick={close}>
      <aside className="drawer" role="dialog" aria-label="session detail" onClick={(event) => event.stopPropagation()}>
        <button className="drawer-x" onClick={close} aria-label="close">
          esc ✕
        </button>
        {children}
      </aside>
    </div>
  )
}

function Nav({ route }: { route: PageRoute }) {
  const onHistory = route.kind === 'history'
  return (
    <nav className="nav">
      <a href="#/" aria-current={route.kind === 'today' ? 'page' : undefined}>
        today
      </a>
      <a href="#/timeline" aria-current={route.kind === 'timeline' ? 'page' : undefined}>
        timeline
      </a>
      <a href="#/history" aria-current={onHistory ? 'page' : undefined}>
        history
      </a>
      {route.kind === 'block' || route.kind === 'week' ? <span className="here">this window</span> : null}
    </nav>
  )
}

export function App() {
  const [theme, toggleTheme] = useTheme()
  const route = useRoute()
  const page = useBase(route)

  return (
    <>
      <div className="top">
        <h1>tally</h1>
        <Nav route={page} />
        <button className="toggle" onClick={toggleTheme}>
          {theme === 'light' ? 'dark' : 'light'}
        </button>
      </div>
      {page.kind === 'history' ? (
        <History />
      ) : page.kind === 'timeline' ? (
        <Timeline from={page.from} to={page.to} />
      ) : page.kind === 'block' ? (
        // keyed on the route so a hash change between two windows remounts: without
        // it the previous window's banner and frozen page stay up under the new key
        <Frozen key={`block-${page.resetKey}`} kind="block" resetKey={page.resetKey} />
      ) : page.kind === 'week' ? (
        <Frozen key={`week-${page.resetsAt}`} kind="week" resetKey={page.resetsAt} />
      ) : (
        <Today />
      )}
      {route.kind === 'session' ? (
        <Drawer base={page}>
          <Session key={`${route.id}@${route.at ?? 'live'}`} id={route.id} at={route.at} />
        </Drawer>
      ) : null}
    </>
  )
}
