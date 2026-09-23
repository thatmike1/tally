// the timeline tab: the meter chart, the block strip and the session lanes on
// one time axis. whatever range is being read (the current block by default, a
// dragged stretch, a clicked block or segment) lives in the hash, so a range is
// a link and the back button undoes a pick; the zoom is the page's own state.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlockSummary, ClaudeHistory, State } from '../api'
import { dayDate, days, duration, hm } from '../format'
import { timelineHref } from '../route'
import { BlockStrip, Chart } from './timeline-chart'
import { useLanes, useLive, useSplit } from './timeline-data'
import { blockHover, chartHover, HoverCard, laneHover, type Hover } from './timeline-hover'
import { buildGroups, Lanes, RailHead, ShareStrip } from './timeline-lanes'
import { usePlotPointer } from './timeline-pointer'
import { Hero, Summary } from './timeline-summary'
import {
  DAY,
  dayStart,
  HOUR,
  MIN,
  periodOf,
  snapStep,
  ticks as axisTicks,
  trimDay,
  zoomFor,
  type Span,
  type Zoom,
} from './timeline-util'
import '../timeline.css'

const FONTS = 'https://fonts.googleapis.com/css2?family=Figtree:wght@300..900&family=Plus+Jakarta+Sans:wght@400..800&display=swap'

/** the first meter sample the history knows, or 8 Sep 2026 before the history lands */
const FIRST_SAMPLE_FALLBACK = 1788818400

export function Timeline({ from, to }: { from: number | undefined; to: number | undefined }) {
  const live = useLive()
  if (live.error && !live.state) return <p className="warn">tally: {live.error}</p>
  return (
    <div className="tl">
      <link rel="stylesheet" href={FONTS} precedence="default" />
      {live.state && live.history ? (
        <TimelineBody state={live.state} history={live.history} codexWindows={live.codex?.windows ?? []} tick={live.tick} from={from} to={to} />
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
}

function TimelineBody({ state, history, codexWindows, tick, from, to }: BodyProps) {
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

  // the zoom and where it sits; a range that falls outside moves the view to it
  const [spec, setSpec] = useState<{ zoom: Zoom; anchor: number }>(() =>
    picked ? { zoom: zoomFor(picked), anchor: (picked.from + picked.to) / 2 } : { zoom: 'day', anchor: now },
  )
  const weekBounds = useMemo(() => history.weeks.map((w) => ({ start: w.start, resetsAt: w.resetsAt })), [history.weeks])
  const period = periodOf(spec.zoom, spec.anchor, weekBounds, since, now)
  useEffect(() => {
    const target = picked ?? currentBlock
    if (target.from >= period.from && target.to <= period.to) return
    const zoom = spec.zoom === 'since' ? 'since' : target.to - target.from > period.to - period.from ? zoomFor(target) : spec.zoom
    setSpec({ zoom, anchor: (target.from + target.to) / 2 })
    // follows the range only; a zoom click must not be undone by it
  }, [from, to])

  const lanes = useLanes(period, tick, now)
  const split = useSplit(sel, tick, now)
  const lanesData = lanes.data
  const meter = lanesData?.meter ?? []

  const view: Span = useMemo(() => {
    if (spec.zoom !== 'day') return period
    const marks: number[] = [sel.from, sel.to]
    if (period.from <= now && now <= period.to) marks.push(now)
    if (running && running.resetsAt <= period.to) marks.push(running.resetsAt)
    if (lanesData && lanes.span && lanes.span.from === period.from) {
      for (const lane of lanesData.lanes) for (const s of lane.segments) marks.push(s.start, s.end)
      for (const point of meter) marks.push(point.t)
    }
    return trimDay(period, marks)
  }, [spec.zoom, period.from, period.to, sel.from, sel.to, lanesData, now])

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

  const tickMarks = axisTicks(view, width)
  const [brush, setBrush] = useState<Span | null>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [hotLane, setHotLane] = useState<string | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)

  const groups = useMemo(
    () => buildGroups(lanesData?.lanes ?? [], split.data, sel, state.codex.split?.threads ?? []),
    [lanesData, split.data, sel.from, sel.to, state.codex.split],
  )
  const rowById = useMemo(() => new Map(groups.flatMap((g) => g.rows.map((row) => [row.id, row] as const))), [groups])

  const go = (range: Span | null) => {
    if (!range || (Math.abs(range.from - currentBlock.from) < 90 && range.to >= now - 150 && running)) {
      window.location.hash = '#/timeline'
      return
    }
    window.location.hash = timelineHref(range.from, range.to)
  }
  const pickBlock = (b: BlockSummary) => go({ from: b.start, to: Math.min(b.resetKey, now) })
  const backToBlock = () => {
    setSpec({ zoom: 'day', anchor: now })
    if (picked) window.location.hash = '#/timeline'
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // the drawer's own Esc closes it first; its body class outlives that hash change
      if (event.key !== 'Escape' || window.location.hash.startsWith('#/session') || document.body.classList.contains('drawer-open')) return
      backToBlock()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const handlers = usePlotPointer({
    view,
    step: snapStep(spec.zoom),
    now,
    onBrush: setBrush,
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
        : chartHover(t, meter, blocks, lanesData?.lanes ?? [], now)
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
  const firstWeek = history.weeks[0]
  const step = (direction: -1 | 1) => {
    if (spec.zoom === 'day') setSpec({ zoom: 'day', anchor: direction < 0 ? period.from - HOUR : period.to + HOUR })
    else if (spec.zoom === 'week') setSpec({ zoom: 'week', anchor: direction < 0 ? period.from - HOUR : period.to + HOUR })
  }
  const canBack = spec.zoom !== 'since' && period.from > dayStart(since) && (spec.zoom === 'day' || !firstWeek || period.from > firstWeek.start)
  const canForward = spec.zoom !== 'since' && period.to < now
  const whereText =
    spec.zoom === 'day'
      ? `${dayDate(period.from)} · ${hm(view.from)} → ${view.to >= period.to ? '24:00' : hm(view.to)}`
      : spec.zoom === 'week'
        ? `${dayDate(period.from)} ${hm(period.from)} → ${dayDate(period.to)} ${hm(period.to)}`
        : `${dayDate(period.from)} → now · every block`
  const zoomTo = (zoom: Zoom) => setSpec({ zoom, anchor: zoom === 'since' ? now : Math.min(now, (sel.from + sel.to) / 2) })
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
              <button key={zoom} aria-pressed={spec.zoom === zoom} onClick={() => zoomTo(zoom)}>
                {zoom === 'since' ? sinceLabel : zoom}
              </button>
            ))}
          </div>
          {spec.zoom !== 'since' ? (
            <button className="tl-step" onClick={() => step(-1)} disabled={!canBack} aria-label={`previous ${spec.zoom}`}>
              ‹
            </button>
          ) : null}
          <span className="tl-where">
            <span className="tl-ctl-k">showing</span> {whereText}
          </span>
          {spec.zoom !== 'since' ? (
            <button className="tl-step" onClick={() => step(1)} disabled={!canForward} aria-label={`next ${spec.zoom}`}>
              ›
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
            <button className="tl-link" onClick={() => setSpec({ zoom: zoomFor(sel), anchor: (sel.from + sel.to) / 2 })}>
              show it on the chart
            </button>
          ) : null}
        </div>
        <span className="tl-hint">
          drag across the chart or a lane to read a range · click a block or a lane segment to read just that · browser back undoes a pick · esc returns to this block
        </span>
      </div>

      <div className="tl-grid-row tl-top">
        <Hero state={state} split={split.data} picked={picked !== null} label={label} sel={sel} />
        <div ref={track} className="tl-track">
          <Chart
            view={view}
            width={width}
            zoom={spec.zoom}
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
          <span>click one to read it{spec.zoom === 'day' ? '' : '; height is where it ended'}</span>
        </div>
        <BlockStrip
          view={view}
          width={width}
          zoom={spec.zoom}
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
          {lanes.loading ? 'reading the lanes…' : lanesData && lanesData.resolution > 300 ? `lanes merge activity closer than ${duration(lanesData.resolution)} at this zoom` : ''}
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
          zoom={spec.zoom}
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
