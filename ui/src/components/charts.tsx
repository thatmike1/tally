import { useEffect, useRef, useState, type RefObject } from 'react'
import type { BlockSummary, ClaudeHistory, CodexWindow, WeekSummary } from '../api'
import { dayDate, dayKey, hm, money, pct, rate } from '../format'

/**
 * the history charts, drawn the way `day.tsx` draws the meter line: a plain
 * `<svg>`, `.tk` ticks, `.grid` rules, colour from the page's own tokens.
 *
 * one rule runs through all of them: a window with no measured movement is not a
 * zero. it is drawn as a cross on the axis and counted in the line underneath,
 * never as a point at the bottom of the scale.
 */

const LEFT = 62
const RIGHT = 22
const TOP = 12
const PLOT = 104
const AXIS = 18

export function useWidth(box: RefObject<HTMLDivElement | null>, min = 520): number {
  const [width, setWidth] = useState(1240)
  useEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(min, entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [box, min])
  return width
}

/** 0 to a round number above the data, with a line through the middle */
function niceMax(max: number): number {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 1.5, 2, 2.5, 5, 10]) {
    if (step * power >= max) return step * power
  }
  return 10 * power
}

/**
 * local midnights inside the span, which is where the day labels go, thinned to
 * about nine: a two-month Codex span has fifty of them and they smear together.
 */
function dayTicks(from: number, to: number): number[] {
  const all: number[] = []
  let previous = dayKey(from)
  for (let t = from; t <= to; t += 1800) {
    const key = dayKey(t)
    if (key !== previous) {
      all.push(t)
      previous = key
    }
  }
  const every = Math.max(1, Math.ceil(all.length / 9))
  return all.filter((_, index) => index % every === 0)
}

interface Point {
  t: number
  value: number
  title: string
}

interface Cross {
  t: number
  title: string
}

type Shape = 'dot' | 'square' | 'triangle'

function Mark({ x, y, shape, className }: { x: number; y: number; shape: Shape; className: string }) {
  if (shape === 'dot') return <circle className={className} cx={x} cy={y} r={4} />
  if (shape === 'square') return <rect className={className} x={x - 4} y={y - 4} width={8} height={8} />
  return <polygon className={className} points={`${x},${y - 5} ${x + 5},${y + 4} ${x - 5},${y + 4}`} />
}

interface Series {
  name: string
  shape: Shape
  /** `c1` is the page accent, `c2` the neutral ink, `cx` the Codex blue */
  tone: 'c1' | 'c2' | 'cx'
  points: Point[]
  crosses: Cross[]
  /** join the points with a line; off when the marks are a scatter, not a path */
  line?: boolean
}

/**
 * one time panel: a shared x span, its own y scale, marks per series and a
 * cross on the axis for every window the sampler could not measure.
 */
function TimePanel({
  width,
  from,
  to,
  series,
  unit,
}: {
  width: number
  from: number
  to: number
  series: Series[]
  unit: string
}) {
  const values = series.flatMap((one) => one.points.map((point) => point.value))
  const top = niceMax(Math.max(...values, 0))
  const span = Math.max(1, to - from)
  const x = (t: number) => LEFT + ((t - from) / span) * (width - LEFT - RIGHT)
  const y = (value: number) => TOP + PLOT - (Math.min(value, top) / top) * PLOT
  const height = TOP + PLOT + AXIS
  const ticks = dayTicks(from, to)

  return (
    <svg width={width} height={height} role="img" aria-label={`${series.map((one) => one.name).join(' and ')} over time`}>
      {[0, 0.5, 1].map((fraction) => (
        <g key={fraction}>
          <line x1={LEFT} x2={width - RIGHT} y1={y(top * fraction)} y2={y(top * fraction)} className="grid" />
          <text x={LEFT - 8} y={y(top * fraction) + 4} className="tk" textAnchor="end">
            {fraction === 0 ? '0' : unit === '$' ? rate(top * fraction) : `${(top * fraction).toFixed(0)}`}
          </text>
        </g>
      ))}
      {ticks[0] === undefined || x(ticks[0]) - LEFT > 70 ? (
        <text x={LEFT + 4} y={height - 4} className="tk">
          {dayDate(from)}
        </text>
      ) : null}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={TOP} y2={TOP + PLOT} className="grid" />
          <text x={x(t) + 4} y={height - 4} className="tk">
            {dayDate(t)}
          </text>
        </g>
      ))}
      {series.map((one) => (
        <g key={one.name}>
          {one.line && one.points.length > 1 ? (
            <polyline
              className={`ch-line ${one.tone}`}
              points={one.points.map((point) => `${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')}
            />
          ) : null}
          {one.points.map((point) => (
            <g key={`${point.t}-${point.value}`}>
              <Mark x={x(point.t)} y={y(point.value)} shape={one.shape} className={`ch-mk ${one.tone}`} />
              <title>{point.title}</title>
            </g>
          ))}
          {one.crosses.map((cross) => (
            <g key={cross.t}>
              <path
                className="ch-none"
                d={`M${x(cross.t) - 4},${TOP + PLOT - 4} l8,8 M${x(cross.t) + 4},${TOP + PLOT - 4} l-8,8`}
              />
              <title>{cross.title}</title>
            </g>
          ))}
        </g>
      ))}
      <line x1={LEFT} x2={width - RIGHT} y1={TOP + PLOT} y2={TOP + PLOT} className="grid" />
    </svg>
  )
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="ch-legend">
      {series.map((one) => (
        <span key={one.name}>
          <svg width={14} height={14} aria-hidden="true">
            <Mark x={7} y={7} shape={one.shape} className={`ch-mk ${one.tone}`} />
          </svg>
          {one.name}
        </span>
      ))}
      <span>
        <svg width={14} height={14} aria-hidden="true">
          <path className="ch-none" d="M3,3 l8,8 M11,3 l-8,8" />
        </svg>
        not measured
      </span>
    </div>
  )
}

function blockSeries(blocks: BlockSummary[]): Series {
  const points: Point[] = []
  const crosses: Cross[] = []
  for (const block of blocks) {
    if (block.measured && block.dollarsPerPercent !== null) {
      points.push({
        t: block.to,
        value: block.dollarsPerPercent,
        title: `${dayDate(block.start)} ${hm(block.start)} · ${rate(block.dollarsPerPercent)} per point · ${money(
          block.usage.cost,
        )} over ${Math.round(block.delta ?? 0)} points`,
      })
    } else if (block.ended) {
      crosses.push({
        t: block.to,
        title: `${dayDate(block.start)} ${hm(block.start)} · ${reasonNotMeasured(block)}`,
      })
    }
  }
  return { name: '5-hour block', shape: 'dot', tone: 'c1', points, crosses }
}

/** why a block carries no dollars-per-point figure, in the words the type documents */
function reasonNotMeasured(block: BlockSummary): string {
  if (block.delta === null) return 'one sample only, no movement to divide'
  if (block.saturated) return 'the meter hit 100%, so the jump is a floor, not a measurement'
  if (block.maxGap > 20 * 60) return `the sampler missed ${Math.round(block.maxGap / 60)} minutes inside it`
  if (block.delta <= 0) return 'the meter did not move'
  return 'not measured'
}

function weekSeries(weeks: WeekSummary[]): Series[] {
  const weekly: Point[] = []
  const weeklyCrosses: Cross[] = []
  const fable: Point[] = []
  const fableCrosses: Cross[] = []
  for (const week of weeks) {
    const when = `week to ${dayDate(week.resetsAt)}`
    if (week.dollarsPerPercent === null) {
      weeklyCrosses.push({ t: week.to, title: `${when} · no measured movement or no Chats breakdown to subtract` })
    } else {
      weekly.push({
        t: week.to,
        value: week.dollarsPerPercent,
        title: `${when} · ${rate(week.dollarsPerPercent)} per point · ${money(week.usage.cost)} over ${Math.round(
          week.delta ?? 0,
        )} points${week.chatsPercent === null ? '' : `, ${pct(week.chatsPercent)} of them Chats`}`,
      })
    }
    if (week.fable.dollarsPerPercent === null) {
      fableCrosses.push({ t: week.to, title: `${when} · ${week.fable.model ?? 'Fable'} did not move` })
    } else {
      fable.push({
        t: week.to,
        value: week.fable.dollarsPerPercent,
        title: `${when} · ${week.fable.model ?? 'Fable'} ${rate(week.fable.dollarsPerPercent)} per point · ${money(
          week.fable.cost,
        )} over ${Math.round(week.fable.delta ?? 0)} points`,
      })
    }
  }
  return [
    { name: 'weekly, Chats taken out', shape: 'square', tone: 'c1', points: weekly, crosses: weeklyCrosses, line: true },
    { name: 'Fable', shape: 'triangle', tone: 'c2', points: fable, crosses: fableCrosses, line: true },
  ]
}

/** chart (a): what a point of each meter costs in list-price dollars, over time */
export function CostPerPercentChart({ history }: { history: ClaudeHistory }) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const blocks = blockSeries(history.blocks)
  const weeks = weekSeries(history.weeks)

  return (
    <div ref={box}>
      <h2 style={{ marginTop: 44 }}>what a meter point costs · list-price dollars per percent</h2>
      <p className="calc">
        The two meters are separate panels because a 5-hour point and a weekly point are different sizes; putting
        them on one scale would say something false.
        <small>computed, no model</small>
      </p>
      <div className="ch-sub">5-hour blocks · {blocks.points.length} measured, {blocks.crosses.length} not</div>
      <TimePanel
        width={width}
        from={history.since}
        to={history.now}
        series={[blocks]}
        unit="$"
      />
      <div className="ch-sub">weekly and Fable · one mark per window</div>
      <TimePanel width={width} from={history.since} to={history.now} series={weeks} unit="$" />
      <Legend series={[blocks, ...weeks]} />
    </div>
  )
}

/** chart (d): how much of each week's meter went to Chats, which leave no transcript */
export function ChatsShareChart({ weeks }: { weeks: WeekSummary[] }) {
  if (!weeks.length) return null
  const known = weeks.filter((week) => week.chatsPercent !== null)
  const top = niceMax(Math.max(...known.map((week) => week.chatsPercent ?? 0), 10))
  return (
    <div>
      <h2 style={{ marginTop: 44 }}>chats share of the weekly meter</h2>
      <div className="ch-cols">
        {weeks.map((week) => {
          const share = week.chatsPercent
          return (
            <div className="ch-col" key={week.resetsAt}>
              <div className="ch-bar" title={breakdownTitle(week)}>
                {share === null ? (
                  <u />
                ) : (
                  <i style={{ height: `${(share / top) * 100}%` }} />
                )}
              </div>
              <b>{share === null ? '—' : pct(share)}</b>
              <em>{dayDate(week.resetsAt)}</em>
              <span>{share === null ? 'not measured' : `${pct(100 - share)} Claude Code`}</span>
            </div>
          )
        })}
      </div>
      <p className="caveat">
        From the last <code>seven_day_breakdown</code> before each reset, kept since 14 Sep 2026; an earlier week has
        no breakdown and is drawn as an empty column, not a zero.
      </p>
    </div>
  )
}

function breakdownTitle(week: WeekSummary): string {
  const rows = week.breakdown?.rows
  if (!rows) return 'no breakdown sampled in this window'
  return Object.entries(rows)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key} ${pct(value)}`)
    .join(' · ')
}

/** chart: Codex credits per weekly percent, the same question in Codex's currency */
export function CodexRateChart({ windows, now }: { windows: CodexWindow[]; now: number }) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  if (!windows.length) return null
  const from = Math.min(...windows.map((window) => window.start))
  const points: Point[] = []
  const crosses: Cross[] = []
  for (const window of windows) {
    const when = `week to ${dayDate(window.resetsAt)}`
    if (window.creditsPerPercent === null) {
      // most past windows moved the meter with no per-call log behind them: Codex
      // only started writing usage per call in September 2026
      const why = window.calls === 0 ? 'no call data behind the meter' : 'no measured movement to divide'
      crosses.push({ t: window.to, title: `${when} · ${why}` })
    } else {
      points.push({
        t: window.to,
        value: window.creditsPerPercent,
        title: `${when} · ${Math.round(window.creditsPerPercent).toLocaleString('en-US')} credits per point · ${Math.round(
          window.credits,
        ).toLocaleString('en-US')} credits over ${Math.round(window.delta ?? 0)} points`,
      })
    }
  }
  const blind = windows.filter((window) => window.creditsPerPercent === null && window.calls === 0)
  const series: Series = { name: 'codex weekly', shape: 'square', tone: 'cx', points, crosses, line: true }
  return (
    <div ref={box}>
      <h2 style={{ marginTop: 32 }}>what a codex point costs · rate-card credits per percent</h2>
      <TimePanel width={width} from={from} to={now} series={[series]} unit="" />
      <div className="ch-sub">
        {points.length} measured window{points.length === 1 ? '' : 's'}
        {blind.length ? ` · ${blind.length} moved the meter with no call data behind it` : ''}
        {crosses.length - blind.length > 0 ? ` · ${crosses.length - blind.length} with no movement to divide` : ''}
      </div>
    </div>
  )
}
