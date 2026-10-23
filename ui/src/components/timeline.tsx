// the timeline tab: the meter chart, the block strip and the session lanes on
// one time axis. whatever range is being read (the current block by default, a
// dragged stretch, a clicked block or segment) lives in the hash, so a range is
// a link and the back button undoes a pick; the view is the page's own state.
//
// the view is free: the wheel or a pinch zooms it around the pointer, from an
// hour to the whole history, and a pan moves it (see timeline-pointer for why a
// pan is not a plain drag). the day, week and since buttons are presets; a
// preset view follows now as it moves, a wheeled or panned one stays put.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlockSummary, ClaudeHistory, State } from '../api'
import { dayDate, days, duration, hm } from '../format'
import { parseRoute, timelineHref, type TimelineView } from '../route'
import { BlockStrip, Chart, codexSeries } from './timeline-chart'
import { useLanes, useLive, useSplit } from './timeline-data'
import { blockHover, chartHover, HoverCard, laneHover, type Hover } from './timeline-hover'
import { buildGroups, Lanes, RailHead, ShareStrip } from './timeline-lanes'
import { usePlotPointer } from './timeline-pointer'
import { Hero, Summary } from './timeline-summary'
import {
  clamp,
  clampView,
  DAY,
  dayStart,
  detailFor,
  HOUR,
  laneResolution,
  lanesWindow,
  MIN,
  panView,
  periodOf,
  snapStep,
  ticks as axisTicks,
  trimDay,
  zoomFor,
  zoomView,
  type Span,
  type Zoom,
} from './timeline-util'
import '../timeline.css'

const FONTS = 'https://fonts.googleapis.com/css2?family=Figtree:wght@300..900&family=Plus+Jakarta+Sans:wght@400..800&display=swap'

/** the first meter sample the history knows, or 8 Sep 2026 before the history lands */
const FIRST_SAMPLE_FALLBACK = 1788818400

export function Timeline({ from, to, view }: { from: number | undefined; to: number | undefined; view: TimelineView | undefined }) {
  const live = useLive()
  if (live.error && !live.state) return <p className="warn">tally: {live.error}</p>
  return (
    <div className="tl">
      <link rel="stylesheet" href={FONTS} precedence="default" />
      {live.state && live.history ? (
        <TimelineBody
          state={live.state}
          history={live.history}
          codexWindows={live.codex?.windows ?? []}
          tick={live.tick}
          from={from}
          to={to}
          initialView={view}
        />
      ) : (
        <p className="tl-mute tl-loading-page">reading the meters…</p>
      )}
    </div>
  )
}

/** `12:25 → 12:56`, with the day when it is not today or the ends are on two days */
function rangeText(range: Span, now: number): string {
  const sameDay = dayStart(range.from) === dayStart(range.to - 1)
  const today = dayStart(range.from) === dayStart(now)
  const end = range.to >= now - 90 ? 'now' : hm(range.to)
  if (sameDay) return today ? `${hm(range.from)} → ${end}` : `${dayDate(range.from)}, ${hm(range.from)} → ${end}`
  return `${dayDate(range.from)} ${hm(range.from)} → ${range.to >= now - 90 ? 'now' : `${dayDate(range.to)} ${hm(range.to)}`}`
}

/** a press of + or - zooms by this much, a wheel notch by about as much */
const KEY_ZOOM = 1.5

/** a preset button's view around `anchor` (null follows now, across midnight too), or a free view set by the wheel, a pan or the keys */
type ViewSpec = { preset: Zoom; anchor: number | null } | { preset: null; view: Span }

function spanLength(range: Span): string {
  const seconds = range.to - range.from
  return seconds < DAY ? duration(seconds) : days(seconds)
}

/** the block a range is exactly, when it is one: from its start to its reset, or to now for the running one */
function blockOf(range: Span, blocks: BlockSummary[], now: number): BlockSummary | null {
  return (
    blocks.find((b) => Math.abs(range.from - b.start) < 90 && Math.abs(range.to - Math.min(b.resetKey, now)) < 150) ?? null
  )
}

interface BodyProps {
  state: State
  history: ClaudeHistory
  codexWindows: NonNullable<ReturnType<typeof useLive>['codex']>['windows']
  tick: number
  from: number | undefined
  to: number | undefined
  /** the view the hash carried when the page opened; after that the view is the page's own */
  initialView: TimelineView | undefined
}

function TimelineBody({ state, history, codexWindows, tick, from, to, initialView }: BodyProps) {
  const now = state.now
  const blocks = history.blocks
  const since = history.since ?? FIRST_SAMPLE_FALLBACK
  const running = state.block && state.fiveHour && !state.fiveHour.ended ? state.block : null
  const currentKey = running ? (blocks.find((b) => !b.ended)?.resetKey ?? null) : null
  const currentBlock: Span = running
    ? { from: running.start, to: Math.min(now, running.resetsAt) }
    : blocks.length
      ? { from: blocks.at(-1)!.start, to: Math.min(blocks.at(-1)!.resetKey, now) }
      : { from: now - 5 * HOUR, to: now }
  const picked: Span | null = from !== undefined && to !== undefined ? { from, to } : null
  const sel = picked ?? currentBlock
  const selBlock = blockOf(sel, blocks, now)

  const label = !picked
    ? `this block, ${rangeText(sel, now)}`
    : selBlock
      ? `the block ${rangeText({ from: selBlock.start, to: Math.min(selBlock.resetKey, now) }, now)}`
      : rangeText(sel, now)

  const weekBounds = useMemo(() => history.weeks.map((w) => ({ start: w.start, resetsAt: w.resetsAt })), [history.weeks])
  // everything a view may show: the first sample's day up to a little past now
  const boundsTo = Math.max(now + 3 * HOUR, running ? running.resetsAt + 30 * MIN : 0)
  const bounds: Span = useMemo(() => ({ from: dayStart(since), to: boundsTo }), [since, boundsTo])

  const presetFor = (range: Span): ViewSpec => ({ preset: zoomFor(range), anchor: Math.min(now, (range.from + range.to) / 2) })

  const [spec, setSpec] = useState<ViewSpec>(() =>
    initialView
      ? 'preset' in initialView
        ? initialView
        : { preset: null, view: initialView }
      : picked
        ? presetFor(picked)
        : { preset: 'day', anchor: null },
  )

  // one width for the chart, the strip and every lane: they share the middle column
  const track = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1100)
  useEffect(() => {
    const element = track.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(Math.max(200, Math.round(element.clientWidth))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const period = spec.preset ? periodOf(spec.preset, spec.anchor ?? now, weekBounds, since, now) : clampView(spec.view, bounds)
  // a day preset reads the lanes for its whole day, so its trim sees every stretch of activity in it;
  // any other view reads a window around itself
  const dayRead: Span | null = spec.preset === 'day' ? { from: Math.max(bounds.from, period.from), to: period.to } : null
  const wideView: Span = spec.preset && spec.preset !== 'day' ? { from: Math.max(bounds.from, period.from), to: Math.min(bounds.to, period.to) } : period
  const lanes = useLanes(dayRead ?? lanesWindow(wideView, bounds), laneResolution(dayRead ?? wideView, width), tick, now)
  const split = useSplit(sel, tick, now)
  const lanesData = lanes.data
  const meter = lanesData?.meter ?? []

  /** the day trimmed to where something happened: the range, now, the blocks, and every lane and meter mark once its lanes are in */
  const trimmedDay = (day: Span): Span => {
    const marks: number[] = [sel.from, sel.to]
    if (day.from <= now && now <= day.to) marks.push(now)
    if (running && running.resetsAt <= day.to) marks.push(running.resetsAt)
    for (const b of blocks) if (b.resetKey > day.from && b.start < day.to) marks.push(b.start, Math.min(b.resetKey, now))
    if (lanesData && dayRead && lanes.span?.from === dayRead.from && lanes.span.to === dayRead.to) {
      for (const lane of lanesData.lanes) for (const segment of lane.segments) marks.push(segment.start, segment.end)
      for (const point of meter) marks.push(point.t)
    }
    return clampView(trimDay(day, marks), bounds)
  }
  const view: Span = spec.preset === 'day' ? trimmedDay(period) : wideView
  // the view the next wheel event starts from, ahead of the render it causes
  const viewNow = useRef(view)
  viewNow.current = view
  const setView = (next: Span) => {
    const clamped = clampView(next, bounds)
    viewNow.current = clamped
    setSpec({ preset: null, view: clamped })
  }

  // the view rides in the hash, so a reload keeps it; replaced rather than pushed,
  // so the back button still steps through picks and not through every wheel notch.
  // today's day preset is the page's default and leaves the hash bare
  const viewParam: TimelineView | undefined =
    spec.preset === null
      ? { from: Math.round(spec.view.from), to: Math.round(spec.view.to) }
      : spec.preset === 'day' && spec.anchor === null && !picked
        ? undefined
        : { preset: spec.preset, anchor: Math.round(spec.anchor ?? now) }
  const viewKey = viewParam ? timelineHref(0, 1, viewParam) : ''
  const viewForHash = useRef(viewParam)
  viewForHash.current = viewParam
  useEffect(() => {
    const sync = () => {
      if (!window.location.hash.startsWith('#/timeline')) return
      const route = parseRoute(window.location.hash)
      if (route.kind !== 'timeline') return
      const want = timelineHref(route.from, route.to, viewForHash.current)
      if (window.location.hash !== want) window.history.replaceState(window.history.state, '', want)
    }
    const timer = setTimeout(sync, 200)
    window.addEventListener('hashchange', sync)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('hashchange', sync)
    }
  }, [viewKey])

  // a range that falls outside moves the view to it: a pan when it fits, its preset when it does not.
  // not on opening: a view the hash brought back stays where it was left. the opening range is
  // forgotten at the first change, so coming back to it later follows it like any other
  const opened = useRef<{ from: number | undefined; to: number | undefined } | null>(initialView ? { from, to } : null)
  useEffect(() => {
    const first = opened.current
    if (first && from === first.from && to === first.to) return
    opened.current = null
    const target = picked ?? currentBlock
    if (target.from >= view.from && target.to <= view.to) return
    const span = view.to - view.from
    if (target.to - target.from > span * 0.9) setSpec(presetFor(target))
    else setView(panView(view, (target.from + target.to) / 2 - (view.from + view.to) / 2, bounds))
    // follows the range only; a zoom must not be undone by it
  }, [from, to])

  const detail = detailFor(view, width)
  const tickMarks = axisTicks(view, width)
  const [brush, setBrush] = useState<Span | null>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [hotLane, setHotLane] = useState<string | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const codex = useMemo(() => codexSeries(codexWindows, state.codex.history ?? []), [codexWindows, state.codex.history])
  const claudeResets = useMemo(
    () => [...new Set(history.weeks.flatMap((w) => [w.start, w.resetsAt]).map((t) => Math.round(t / 60) * 60))].filter((t) => t <= now),
    [history.weeks, now],
  )

  // the lanes are read for more than the view; a session shows when it ran on screen or in the range being read
  const groups = useMemo(() => {
    const touches = (lane: { start: number; end: number; segments: { start: number; end: number }[] }, span: Span) =>
      lane.segments.length
        ? lane.segments.some((segment) => segment.end >= span.from && segment.start <= span.to)
        : lane.end >= span.from && lane.start <= span.to
    const shown = (lanesData?.lanes ?? []).filter((lane) => touches(lane, view) || touches(lane, sel))
    return buildGroups(shown, split.data, sel, state.codex.split?.threads ?? [])
  }, [lanesData, split.data, sel.from, sel.to, state.codex.split, view.from, view.to])
  const rowById = useMemo(() => new Map(groups.flatMap((g) => g.rows.map((row) => [row.id, row] as const))), [groups])

  const go = (range: Span | null) => {
    if (!range || (Math.abs(range.from - currentBlock.from) < 90 && range.to >= now - 150 && running)) {
      window.location.hash = '#/timeline'
      return
    }
    window.location.hash = timelineHref(range.from, range.to, viewForHash.current)
  }
  const pickBlock = (b: BlockSummary) => go({ from: b.start, to: Math.min(b.resetKey, now) })
  const backToBlock = () => {
    setSpec({ preset: 'day', anchor: null })
    if (picked) window.location.hash = '#/timeline'
  }
  const resetView = () => setSpec(picked ? presetFor(picked) : { preset: 'day', anchor: null })
  const zoomBy = (factor: number, at?: number) => {
    const current = viewNow.current
    setView(zoomView(current, factor, at ?? (current.from + current.to) / 2, bounds))
  }
  const panBy = (fraction: number) => {
    const current = viewNow.current
    setView(panView(current, fraction * (current.to - current.from), bounds))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // the drawer's own Esc and keys come first; its body class outlives that hash change
      if (window.location.hash.startsWith('#/session') || document.body.classList.contains('drawer-open')) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return
      if (event.key === 'Escape') backToBlock()
      else if (event.key === '+' || event.key === '=') zoomBy(1 / KEY_ZOOM)
      else if (event.key === '-' || event.key === '_') zoomBy(KEY_ZOOM)
      else if (event.key === 'ArrowLeft') panBy(-0.25)
      else if (event.key === 'ArrowRight') panBy(0.25)
      else if (event.key === '0') resetView()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // the wheel zooms around the pointer on the chart and the strip; a pinch (a
  // wheel with ctrl) zooms on any plot; a sideways scroll or shift-wheel pans.
  // a plain vertical wheel over a lane is left to scroll the page.
  const wheel = useRef({ zoomBy, setView, bounds })
  wheel.current = { zoomBy, setView, bounds }
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const plot = event.target instanceof Element ? event.target.closest('.tl-chart, .tl-strip, .tl-lane') : null
      if (!plot) return
      const box = plot.getBoundingClientRect()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1
      const dx = event.deltaX * scale
      const dy = event.deltaY * scale
      const current = viewNow.current
      const span = current.to - current.from
      const onLane = plot.classList.contains('tl-lane')
      if (event.ctrlKey || (!onLane && !event.shiftKey && Math.abs(dy) >= Math.abs(dx))) {
        event.preventDefault()
        const at = current.from + clamp((event.clientX - box.left) / box.width, 0, 1) * span
        wheel.current.zoomBy(Math.exp(dy * (event.ctrlKey ? 0.01 : 0.003)), at)
        return
      }
      const sideways = dx !== 0 ? dx : event.shiftKey ? dy : 0
      if (sideways === 0 || Math.abs(sideways) < Math.abs(dy) * (event.shiftKey ? 0 : 1)) return
      event.preventDefault()
      wheel.current.setView(panView(current, (sideways / box.width) * span, wheel.current.bounds))
    }
    document.addEventListener('wheel', onWheel, { passive: false })
    return () => document.removeEventListener('wheel', onWheel)
  }, [])

  const handlers = usePlotPointer({
    view,
    step: snapStep(view, width),
    now,
    onBrush: setBrush,
    onPan: setView,
    onHover: (t, event, laneId) => {
      setHoverT(t)
      setHotLane(laneId)
      if (t === null || !event) {
        setHover(null)
        return
      }
      const row = laneId ? rowById.get(laneId) : null
      const body = row
        ? laneHover(t, row.lane, row.title, now, width / (view.to - view.from))
        : chartHover(t, meter, blocks, lanesData?.lanes ?? [], now, codex, claudeResets, 6 / (width / (view.to - view.from)), Math.max(20 * MIN, 1.5 * (lanesData?.resolution ?? 0)))
      setHover({ x: event.clientX, y: event.clientY, body })
    },
    onPick: go,
    onClick: (t, laneId) => {
      const lane = laneId ? rowById.get(laneId)?.lane : null
      const slack = Math.max(60, 4 / (width / (view.to - view.from)))
      const segment = lane?.segments.find((s) => t >= s.start - slack && t <= s.end + slack)
      if (segment) {
        go({ from: Math.floor(segment.start / 60) * 60, to: Math.min(now, Math.ceil((segment.end + 1) / 60) * 60) })
        return
      }
      const block = blocks.find((b) => t >= b.start && t < b.resetKey)
      if (block) pickBlock(block)
    },
  })

  const range = split.data?.fiveHour ?? null
  const outOfView = sel.to < view.from || sel.from > view.to
  const viewHasNow = view.from <= now && now <= view.to + 10 * MIN
  // a day or week preset steps to the day or week next to it; a free view moves by its own width
  const step = (direction: -1 | 1) => {
    if (spec.preset === 'day' || spec.preset === 'week') setSpec({ preset: spec.preset, anchor: direction < 0 ? period.from - HOUR : period.to + HOUR })
    else panBy(direction)
  }
  const canBack = view.from > bounds.from + MIN
  const canForward = spec.preset === 'day' || spec.preset === 'week' ? period.to < now : view.to < bounds.to - MIN
  const sameDay = dayStart(view.from) === dayStart(view.to - 1)
  const whereText =
    spec.preset === 'day'
      ? `${dayDate(period.from)} · ${hm(view.from)} → ${view.to >= period.to ? '24:00' : hm(view.to)}`
      : spec.preset === 'week'
        ? `${dayDate(period.from)} ${hm(period.from)} → ${dayDate(period.to)} ${hm(period.to)}`
        : spec.preset === 'since'
          ? `${dayDate(view.from)} → now · every block`
          : sameDay
            ? `${dayDate(view.from)} · ${hm(view.from)} → ${hm(view.to)} · ${spanLength(view)}`
            : `${dayDate(view.from)} ${hm(view.from)} → ${dayDate(view.to)} ${hm(view.to)} · ${spanLength(view)}`
  const zoomTo = (zoom: Zoom) => setSpec({ preset: zoom, anchor: zoom === 'since' || !picked ? null : Math.min(now, (sel.from + sel.to) / 2) })
  const sinceLabel = `since ${dayDate(since).replace(/^\w+ /, '')}`

  const title =
    range === null
      ? 'who ran in this range'
      : range.delta === null
        ? 'who ran; the meter measured nothing here'
        : range.delta === 0
          ? 'who ran; the meter did not move'
          : `who ate the ${range.delta} point${range.delta === 1 ? '' : 's'}`

  return (
    <>
      <div className="tl-controls">
        <div className="tl-ctl">
          <span className="tl-ctl-k">zoom</span>
          <div className="tl-seg" role="group" aria-label="zoom">
            {(['day', 'week', 'since'] as const).map((zoom) => (
              <button key={zoom} aria-pressed={spec.preset === zoom} onClick={() => zoomTo(zoom)}>
                {zoom === 'since' ? sinceLabel : zoom}
              </button>
            ))}
          </div>
          {spec.preset !== 'since' ? (
            <button className="tl-step" onClick={() => step(-1)} disabled={!canBack} aria-label={`previous ${spec.preset ?? 'stretch'}`}>
              ‹
            </button>
          ) : null}
          <span className="tl-where">
            <span className="tl-ctl-k">showing</span> {whereText}
          </span>
          {spec.preset !== 'since' ? (
            <button className="tl-step" onClick={() => step(1)} disabled={!canForward} aria-label={`next ${spec.preset ?? 'stretch'}`}>
              ›
            </button>
          ) : null}
          {spec.preset === null ? (
            <button className="tl-link" onClick={resetView}>
              reset view
            </button>
          ) : null}
        </div>
        <div className={`tl-ctl tl-reading${picked ? ' tl-reading-picked' : ''}`}>
          <span className="tl-ctl-k">reading</span>
          <span className="tl-range">
            <b>{label}</b> <span className="tl-range-len">{spanLength(sel)}</span>
          </span>
          {picked || !viewHasNow ? (
            <button className="tl-back" onClick={backToBlock}>
              ✕ back to this block
            </button>
          ) : (
            <span className="tl-live-tag">live, follows the block</span>
          )}
          {outOfView ? (
            <button className="tl-link" onClick={() => setSpec(presetFor(sel))}>
              show it on the chart
            </button>
          ) : null}
        </div>
        <span className="tl-hint">
          drag across the chart or a lane to read a range · click a block or a lane segment to read just that · wheel or pinch to zoom, + and − too · shift-drag, drag the time axis or ← → to pan · 0 resets the view · browser back undoes a pick · esc returns to this block
        </span>
      </div>

      <div className="tl-grid-row tl-top">
        <Hero state={state} split={split.data} picked={picked !== null} label={label} sel={sel} />
        <div ref={track} className="tl-track">
          <Chart
            view={view}
            width={width}
            detail={detail}
            step={lanesData?.resolution ?? 300}
            now={now}
            ticks={tickMarks}
            meter={meter}
            state={state}
            blocks={blocks}
            weeks={history.weeks}
            codexWindows={codexWindows}
            scopedModel={lanesData?.scopedModel ?? null}
            sel={sel}
            brush={brush}
            hoverT={hoverT}
            handlers={handlers(null)}
          />
        </div>
        <Summary split={split.data} loading={split.loading} picked={picked !== null} label={label} />
      </div>

      <div className="tl-grid-row tl-strip-row">
        <div className="tl-strip-k">
          5-hour blocks
          <span>click one to read it{detail === 'fine' ? '' : '; height is where it ended'}</span>
        </div>
        <BlockStrip
          view={view}
          width={width}
          detail={detail}
          now={now}
          blocks={blocks}
          selectedKey={picked ? (selBlock?.resetKey ?? null) : currentKey}
          currentKey={currentKey}
          onPick={pickBlock}
          onHover={(block, event) =>
            setHover(block ? { x: event.clientX, y: event.clientY, body: blockHover(block, block.resetKey === currentKey, now) } : null)
          }
        />
        <div className="tl-strip-note tl-mute">
          {lanes.loading ? 'reading the lanes…' : lanesData && lanesData.resolution > 300 ? `lanes merge activity closer than ${duration(lanesData.resolution)} at this width` : ''}
        </div>
      </div>

      <div className={`tl-grid-row tl-lanes-head${split.loading ? ' tl-loading' : ''}`}>
        <div>
          <h3 className="tl-h3">{title}</h3>
          <div className="tl-mute tl-small">{label} · split by list cost, measured per request by the server</div>
          <ShareStrip rows={range?.sessions ?? []} />
          <div className="tl-col-k">share of the 5-hour movement, ~points</div>
        </div>
        <div className="tl-lanes-k">session lanes · a bar is activity, not span · thicker where subagents ran, brighter where it spent faster</div>
        <RailHead />
      </div>
      <div className={split.loading ? 'tl-loading' : undefined}>
        <Lanes
          groups={groups}
          split={split.data}
          state={state}
          view={view}
          width={width}
          detail={detail}
          ticks={tickMarks}
          sel={sel}
          brush={brush}
          hoverT={hoverT}
          hotLane={hotLane}
          handlers={handlers}
        />
      </div>
      {split.data ? (
        <p className="tl-foot">
          {split.data.caveat} {split.data.weekCaveat} Codex threads carry no Claude usage; their share and credits are this Codex week's.
        </p>
      ) : null}
      <HoverCard hover={hover} />
    </>
  )
}
