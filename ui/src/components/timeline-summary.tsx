// the two sides of the chart: on the left the big number for the range being
// read and the meters as the chart's legend, on the right what the range was
// made of (the token mix, its list cost per kind, the predecessor's price).
import type { RangeMeterSplit, RangeSplit, State } from '../api'
import { days, hm, money, tokens, until } from '../format'
import { modelName, realModels, type Span } from './timeline-util'

export interface HeroProps {
  state: State
  split: RangeSplit | null
  picked: boolean
  label: string
  sel: Span
}

function movement(meter: RangeMeterSplit | null): { start: number; end: number; delta: number | null } | null {
  if (!meter || !meter.pieces.length) return null
  return { start: meter.pieces[0]!.startPct, end: meter.pieces.at(-1)!.endPct, delta: meter.delta }
}

function moved(m: { start: number; end: number; delta: number | null } | null): string {
  if (!m) return 'no reading in the range'
  if (m.delta === null) return `${m.end}% · one reading, nothing measured`
  if (m.delta === 0) return `${m.start} → ${m.end}% · did not move`
  return `${m.start} → ${m.end}% · +${m.delta}`
}

/** the Codex meter's readings inside the range: the current week's only */
function codexMovement(state: State, sel: Span): { start: number; end: number; delta: number | null } | null {
  const inside = (state.codex.history ?? []).filter((p) => p.t >= sel.from && p.t <= sel.to)
  const first = inside[0]
  const last = inside.at(-1)
  if (!first || !last) return null
  return { start: first.pct, end: last.pct, delta: inside.length > 1 ? last.pct - first.pct : null }
}

function verdict(state: State) {
  const projection = state.block?.projection
  if (!state.fiveHour || state.fiveHour.ended) return <span className="tl-mute">no block running; the next message opens one</span>
  if (!projection?.ready) return <span className="tl-mute">too early in the block to project</span>
  if (projection.hitsHundredAt) return <span className="tl-bad">100% at {hm(projection.hitsHundredAt)}</span>
  return (
    <>
      <span className="tl-good">you make it</span> · ≈ {Math.round(projection.pctAtReset)}% at reset
    </>
  )
}

export function Hero({ state, split, picked, label, sel }: HeroProps) {
  const five = state.fiveHour
  const range = split?.fiveHour ?? null
  const weekly = picked ? movement(split?.weekly ?? null) : null
  const fable = picked ? movement(split?.fable ?? null) : null
  const codex = picked ? codexMovement(state, sel) : null
  const pieces = range?.pieces ?? []

  return (
    <div className="tl-hero">
      {picked ? (
        <>
          <div className={`tl-big tl-big-delta${range?.delta === null || range === null ? ' tl-big-none' : ''}`}>
            {range === null ? '…' : range.delta === null ? '–' : `+${range.delta}`}
          </div>
          <div className="tl-under">
            points of the 5-hour meter in <b>{label}</b>
          </div>
          <div className="tl-under tl-mute">
            {range === null
              ? 'reading the range…'
              : pieces.length === 0
                ? 'no meter reading falls inside it'
                : pieces.length === 1
                  ? pieces[0]!.delta === null
                    ? `one reading (${pieces[0]!.endPct}% at ${hm(pieces[0]!.to)}), so nothing is measured`
                    : `measured: ${hm(pieces[0]!.from)} read ${pieces[0]!.startPct}%, ${hm(pieces[0]!.to)} read ${pieces[0]!.endPct}%`
                  : `added up over ${pieces.length} blocks, each read on its own`}
            {pieces.some((p) => p.saturated) ? ' · hit 100%, so a floor' : ''}
          </div>
          {five ? (
            <div className="tl-under tl-mute">
              meter now {five.pct}% · {five.ended ? 'block over' : `resets ${hm(five.resetsAt)}`}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="tl-big">
            {five ? five.pct : '–'}
            <span className="tl-unit">%</span>
          </div>
          <div className="tl-under">
            {five && !five.ended
              ? `5-hour block · resets ${hm(five.resetsAt)}, in ${until(five.resetsAt - state.now)} · read ${Math.round(five.ageSeconds / 60)}m ago`
              : 'no 5-hour block running'}
          </div>
          <div className="tl-verdict">{verdict(state)}</div>
        </>
      )}
      <div className="tl-legend">
        <i className="tl-sw tl-sw-five" />
        <span className="tl-legend-name">5-hour</span>
        <span className="tl-legend-v tl-mute">thick line; dashed is this block's pace to the reset</span>
        <i className="tl-sw tl-sw-wk" />
        <span className="tl-legend-name">weekly</span>
        <span className="tl-legend-v">
          {picked ? (
            moved(weekly)
          ) : state.weekly ? (
            <>
              <b>{state.weekly.pct}%</b> <span className="tl-good">{state.weekly.verdict?.phrase ?? ''}</span>{' '}
              <span className="tl-mute">
                resets in {days((state.weekly.resetsAt ?? state.now) - state.now)}
              </span>
            </>
          ) : (
            'no reading'
          )}
        </span>
        {state.fable ? (
          <>
            <i className="tl-sw tl-sw-fb" />
            <span className="tl-legend-name">{state.fable.model}</span>
            <span className="tl-legend-v">
              {picked ? (
                moved(fable)
              ) : (
                <>
                  <b>{state.fable.pct}%</b> <span className="tl-good">{state.fable.verdict?.phrase ?? ''}</span>
                </>
              )}
            </span>
          </>
        ) : null}
        {state.codex.status !== 'absent' ? (
          <>
            <i className="tl-sw tl-sw-cx" />
            <span className="tl-legend-name">Codex</span>
            <span className="tl-legend-v">
              {picked ? (
                codex ? (
                  moved(codex)
                ) : (
                  <span className="tl-mute">readings kept for this Codex week only</span>
                )
              ) : state.codex.usedPercent !== null ? (
                <>
                  <b>{state.codex.usedPercent}%</b> <span className="tl-mute">{state.codex.pace?.phrase ?? ''}</span>
                </>
              ) : (
                'no reading'
              )}
            </span>
          </>
        ) : null}
      </div>
    </div>
  )
}

const KINDS = [
  { key: 'in', label: 'input', cls: 'tl-k-in' },
  { key: 'cw5m', label: 'cache write 5m', cls: 'tl-k-cw5' },
  { key: 'cw1h', label: 'cache write 1h', cls: 'tl-k-cw1' },
  { key: 'cr', label: 'cache read', cls: 'tl-k-cr' },
  { key: 'out', label: 'output', cls: 'tl-k-out' },
] as const

export interface SummaryProps {
  split: RangeSplit | null
  loading: boolean
  picked: boolean
  label: string
}

/** the range's token mix and list cost per kind, with the predecessor model's price beside it */
export function Summary({ split, loading, picked, label }: SummaryProps) {
  const range = split?.fiveHour ?? null
  const usage = range?.usage ?? null
  const models = usage ? realModels(usage.costByModel) : []
  const compare = usage?.compare ?? []
  // one predecessor column only when a single compared model is the whole range
  const single = compare.length === 1 && usage && Math.abs(compare[0]!.cost - usage.cost) < 0.01 ? compare[0]! : null
  const totalTokens = usage ? usage.buckets.in + usage.buckets.cw5m + usage.buckets.cw1h + usage.buckets.cr + usage.buckets.out : 0

  return (
    <div className={`tl-summary${loading ? ' tl-loading' : ''}`}>
      <h3 className="tl-h3">{picked ? 'the range' : 'the whole block'}</h3>
      <div className="tl-mute tl-small">
        {label}
        {usage ? ` · ${usage.requests} requests` : ''}
        {models.length ? ` · ${models.map((m) => `${modelName(m.model)} ${money(m.cost)}`).join(', ')}` : ''}
      </div>
      {usage && usage.requests > 0 ? (
        <>
          <div className="tl-mix-strip" aria-hidden="true">
            {KINDS.map((kind) => {
              const cost = usage.costByKind[kind.key]
              return cost > 0 ? <span key={kind.key} className={kind.cls} style={{ flexBasis: `${(cost / usage.cost) * 100}%` }} /> : null
            })}
          </div>
          <div className={`tl-mix${single ? ' tl-mix-cmp' : ''}`}>
            <span />
            <span className="tl-mix-h">list cost by token kind</span>
            <span className="tl-mix-h tl-r">tokens</span>
            <span className="tl-mix-h tl-r">{single ? modelName(single.model) : 'list cost'}</span>
            {single ? <span className="tl-mix-h tl-r">at {modelName(single.predecessor)}</span> : null}
            {KINDS.map((kind) => (
              <MixRow
                key={kind.key}
                cls={kind.cls}
                label={kind.label}
                tokens={usage.buckets[kind.key]}
                cost={usage.costByKind[kind.key]}
                before={single ? single.predecessorCostByKind[kind.key] : null}
              />
            ))}
            <span className="tl-mix-tot" />
            <span className="tl-mix-tot">total</span>
            <span className="tl-mix-tot tl-r tl-num">{tokens(totalTokens)}</span>
            <span className="tl-mix-tot tl-r tl-num">{money(usage.cost)}</span>
            {single ? <span className="tl-mix-tot tl-r tl-num tl-mute">{money(single.predecessorCost)}</span> : null}
          </div>
          {compare.map((row) =>
            row.ratio === null ? null : (
              <p key={row.model} className="tl-cmp">
                At {modelName(row.predecessor)} prices {single ? 'the same tokens' : `the ${modelName(row.model)} part`} would cost{' '}
                <b>{money(row.predecessorCost)}</b>, so {modelName(row.model)} is{' '}
                <b>
                  {Math.round(Math.abs(1 - row.ratio) * 100)}% {row.ratio < 1 ? 'cheaper' : 'dearer'}
                </b>{' '}
                here{row.ratio < 1 && row.costByKind.cr > 0 && row.predecessorCostByKind.cr > row.costByKind.cr * 1.5 ? ', mostly from cheaper cache reads' : ''}.
              </p>
            ),
          )}
          {usage.unpriced ? <p className="tl-cmp tl-mute">A model here has no price row, so the cost is a floor.</p> : null}
        </>
      ) : range ? (
        <p className="tl-cmp tl-mute">No Claude request landed in this range.</p>
      ) : (
        <p className="tl-cmp tl-mute">reading the range…</p>
      )}
      {range && (range.costUnmeasured > 0.01 || (range.pointsUnattributed ?? 0) > 0) ? (
        <p className="tl-cmp tl-mute tl-small">
          {range.costUnmeasured > 0.01
            ? `${money(range.costUnmeasured)} of it ran outside the span the meter readings cover (before the first or after the last), so no points are split onto it. `
            : ''}
          {(range.pointsUnattributed ?? 0) > 0
            ? `${Math.round(range.pointsUnattributed!)} points moved with no local request to split them over (Chats, or another machine).`
            : ''}
        </p>
      ) : null}
      {split?.index.building || split?.index.cold ? (
        <p className="tl-cmp tl-mute tl-small">
          The transcript index is still building ({split.index.done} of {split.index.total} files), so some requests may be missing.
        </p>
      ) : null}
    </div>
  )
}

/** list dollars, where a zero reads `$0.00` rather than money's `<1c` */
function usd(value: number): string {
  return value === 0 ? '$0.00' : money(value)
}

function MixRow({ cls, label, tokens: count, cost, before }: { cls: string; label: string; tokens: number; cost: number; before: number | null }) {
  return (
    <>
      <span className={`tl-mix-key ${cls}`} />
      <span>{label}</span>
      <span className="tl-r tl-num">{tokens(count)}</span>
      <span className="tl-r tl-num">{usd(cost)}</span>
      {before !== null ? <span className="tl-r tl-num tl-mute">{usd(before)}</span> : null}
    </>
  )
}
