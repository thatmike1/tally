// what the timeline reads from the server: the live state and history for the
// current block and the block strip, the lanes for the window on screen, and
// the exact split for the picked range. every hook keeps its last answer while
// the next one loads, so the page never blanks between two drags.
import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchCodexHistory,
  fetchHistory,
  fetchState,
  type ClaudeHistory,
  type CodexHistory,
  type RangeLanes,
  type RangeSplit,
  type State,
} from '../api'
import type { Span } from './timeline-util'

const POLL_MS = 60_000
/** the server answers a lanes window of at most this many seconds */
const MAX_RANGE = 92 * 86400

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    let message = `tally server answered ${response.status}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // a non-json error body says nothing the status has not
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

function rangeQuery(span: Span): string {
  const to = Math.round(span.to)
  const from = Math.max(Math.round(span.from), to - MAX_RANGE)
  return `from=${from}&to=${to}`
}

export interface Live {
  state: State | null
  history: ClaudeHistory | null
  /** only past Codex weeks are drawn from it; null until its slow first answer lands */
  codex: CodexHistory | null
  error: string | null
  /** bumps on every state poll, so range hooks that end at now re-ask */
  tick: number
}

/** the state and history, polled once a minute; never moves the "last looked" marker */
export function useLive(): Live {
  const [live, setLive] = useState<Live>({ state: null, history: null, codex: null, error: null, tick: 0 })
  useEffect(() => {
    let alive = true
    let rounds = 0
    const load = async () => {
      const withHistory = rounds % 5 === 0
      rounds++
      try {
        const [state, history] = await Promise.all([fetchState(true), withHistory ? fetchHistory() : Promise.resolve(null)])
        if (!alive) return
        setLive((current) => ({
          ...current,
          state,
          history: history ?? current.history,
          error: null,
          tick: current.tick + 1,
        }))
      } catch (problem) {
        if (alive) setLive((current) => ({ ...current, error: problem instanceof Error ? problem.message : String(problem) }))
      }
    }
    void load()
    // the Codex history reads every rollout and takes seconds; it only draws past weeks
    fetchCodexHistory()
      .then((codex) => {
        if (alive) setLive((current) => ({ ...current, codex }))
      })
      .catch(() => {})
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return live
}

export interface Loaded<T> {
  data: T | null
  /** the span `data` answers for; the page keeps drawing it while a new one loads */
  span: Span | null
  loading: boolean
  error: string | null
}

/**
 * one endpoint over one span, re-asked when the span changes or, when it
 * reaches now, on every poll `tick`. a late answer for an old span is dropped.
 */
function useRange<T>(path: string, span: Span | null, tick: number, now: number): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ data: null, span: null, loading: false, error: null })
  const asked = useRef(0)
  const live = span !== null && span.to >= now - 120
  const key = span ? `${Math.round(span.from)}:${Math.round(span.to)}` : ''
  useEffect(() => {
    if (!span) return
    const ticket = ++asked.current
    setLoaded((current) => ({ ...current, loading: true }))
    getJson<T>(`${path}?${rangeQuery(span)}`)
      .then((data) => {
        if (ticket === asked.current) setLoaded({ data, span, loading: false, error: null })
      })
      .catch((problem: unknown) => {
        if (ticket === asked.current)
          setLoaded((current) => ({ ...current, loading: false, error: problem instanceof Error ? problem.message : String(problem) }))
      })
    // the span object changes identity every render; its rounded ends are what matter
  }, [path, key, live ? tick : 0])
  return loaded
}

/** lanes and meter points for the window on screen */
export function useLanes(span: Span | null, tick: number, now: number): Loaded<RangeLanes> {
  return useRange<RangeLanes>('/api/lanes', span, tick, now)
}

/** the exact split of the range being read */
export function useSplit(span: Span | null, tick: number, now: number): Loaded<RangeSplit> {
  return useRange<RangeSplit>('/api/split', span, tick, now)
}
