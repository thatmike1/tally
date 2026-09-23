import { useState, type CSSProperties, type ReactNode } from 'react'
import type { SplitUsage } from '../api'
import { money, tokens } from '../format'
import { Tip } from './tip'
import { modelName, realModels, share } from './words'

/**
 * the pieces every section of the answer page is built from: a question with its
 * lead on the left and the evidence on the right, a ledger of rows that open in
 * place, a statement that opens in place, and the token mix of a window.
 */

export function Question({
  id,
  title,
  lead,
  aside,
  children,
}: {
  id: string
  title: ReactNode
  lead: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="q" id={id}>
      <div className="q-head">
        <h2>{title}</h2>
        <p className="lead">{lead}</p>
        {aside}
      </div>
      <div className="q-body">{children}</div>
    </section>
  )
}

/** one figure in a ledger cell: the big number and the small line under it */
export interface Cell {
  main: ReactNode
  sub?: ReactNode
  /** the secondary columns set smaller than the headline share */
  small?: boolean
}

export interface Column {
  head: ReactNode
  /** a css grid track, `118px` */
  width: string
}

export interface LedgerRow {
  key: string
  color: string
  name: ReactNode
  /** after the name, smaller: model, effort, subagents, live */
  tags?: ReactNode
  /** the grey line under the name */
  subtitle?: ReactNode
  cells: Cell[]
  /** what opens in place; a row without it does not open */
  more?: ReactNode
}

/**
 * one row per session, every meter on the same line. the first column is the
 * name; `columns` are the figures after it, right-aligned, in the order given.
 */
export function Ledger({
  columns,
  rows,
  first,
  open: initial = [],
}: {
  columns: Column[]
  rows: LedgerRow[]
  /** the head of the name column */
  first: ReactNode
  /** keys open from the start */
  open?: string[]
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initial))
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const grid: CSSProperties = {
    gridTemplateColumns: `minmax(0, 1fr) ${columns.map((column) => column.width).join(' ')} 28px`,
  }
  return (
    <div className="ledger">
      <div className="rail" style={grid}>
        <div>{first}</div>
        {columns.map((column, index) => (
          <div key={index}>{column.head}</div>
        ))}
        <div />
      </div>
      {rows.map((row) => {
        const isOpen = open.has(row.key)
        const line = (
          <>
            <span className="who">
              <span className="dot" style={{ background: row.color }} />
              <span className="nm">
                <span className="nick">
                  {row.name}
                  {row.tags ? <span className="tag">{row.tags}</span> : null}
                </span>
                {row.subtitle ? <span className="ttl">{row.subtitle}</span> : null}
              </span>
            </span>
            {row.cells.map((cell, index) => (
              <span className="n" key={index}>
                <span className={cell.small ? 'main small' : 'main'}>{cell.main}</span>
                {cell.sub ? <span className="sub">{cell.sub}</span> : null}
              </span>
            ))}
            <span className="pm" aria-hidden="true">
              {row.more ? (isOpen ? '−' : '+') : ''}
            </span>
          </>
        )
        return (
          <div className={isOpen ? 'lrow open' : 'lrow'} key={row.key}>
            {row.more ? (
              <button
                type="button"
                className="row-line"
                style={grid}
                aria-expanded={isOpen}
                onClick={() => toggle(row.key)}
              >
                {line}
              </button>
            ) : (
              <div className="row-line" style={grid}>
                {line}
              </div>
            )}
            {isOpen && row.more ? <div className="row-more">{row.more}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

/** a sentence that opens into its evidence */
export function Statement({ line, children }: { line: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={open ? 'st open' : 'st'}>
      <button type="button" className="st-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="st-text">{line}</span>
        <span className="pm" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open ? <div className="st-more">{children}</div> : null}
    </div>
  )
}

/** the part-to-whole strip over a ledger; colours follow the rows */
export function Strip({ parts }: { parts: { key: string; share: number; color: string; tip: ReactNode }[] }) {
  return (
    <div className="strip">
      {parts
        .filter((part) => part.share > 0)
        .map((part) => (
          <Tip
            key={part.key}
            tip={part.tip}
            className="strip-part"
            style={{ flexGrow: part.share, flexBasis: 0, background: part.color }}
          >
            {null}
          </Tip>
        ))}
    </div>
  )
}

/**
 * the window's token mix with the list cost of each kind, and the same tokens
 * at the price of the model each one replaced where the server has one.
 */
export function UsageTotals({ usage }: { usage: SplitUsage }) {
  const { buckets, costByKind } = usage
  const all = buckets.in + buckets.cw5m + buckets.cw1h + buckets.cr + buckets.out
  const allModels = realModels(usage.costByModel).map((one) => modelName(one.model))
  const models = allModels.length > 3 ? [...allModels.slice(0, 3), `+${allModels.length - 3} more`] : allModels
  const floor = usage.unpriced ? '*' : ''
  return (
    <div className="totals">
      <Total label="requests" value={usage.requests.toLocaleString('en-US')} note={models.join(', ')} />
      <Total label="cache reads" value={tokens(buckets.cr)} note={money(costByKind.cr)} />
      <Total
        label="cache writes 5m · 1h"
        value={
          <>
            {tokens(buckets.cw5m)} · {tokens(buckets.cw1h)}
          </>
        }
        note={money(costByKind.cw5m + costByKind.cw1h)}
      />
      <Total label="output" value={tokens(buckets.out)} note={money(costByKind.out)} />
      <Total label="input" value={tokens(buckets.in)} note={money(costByKind.in)} />
      <Total label="list cost" value={`${money(usage.cost)}${floor}`} note={usage.unpriced ? 'a floor' : 'total'} />
      <div className="cmpnote">
        {all > 0 && usage.cost > 0 ? (
          <>
            Cache reads are <span className="cmp">{share(buckets.cr / all)}</span> of the tokens and{' '}
            <span className="cmp">{share(costByKind.cr / usage.cost)}</span> of the cost.{' '}
          </>
        ) : null}
        <Compare usage={usage} />
        {usage.unpriced ? ' A request here has no price row, so the total is a floor.' : ''}
      </div>
    </div>
  )
}

function Total({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
  return (
    <div className="tot">
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {note ? <small>{note}</small> : null}
      </div>
    </div>
  )
}

/** `At opus 5 prices the same tokens cost $13.58: 47% cheaper here.` */
function Compare({ usage }: { usage: SplitUsage }) {
  const rows = usage.compare.filter((row) => row.ratio !== null && row.predecessorCost > 0)
  if (!rows.length) return null
  return (
    <>
      {rows.map((row) => {
        const whole = row.requests >= usage.requests - realModelsMissing(usage)
        const change = 1 - row.ratio!
        const word = change >= 0 ? 'cheaper' : 'dearer'
        return (
          <span key={row.model}>
            At {modelName(row.predecessor)} prices{' '}
            {whole ? 'the same tokens' : `the ${modelName(row.model)} tokens`} cost{' '}
            <span className="cmp">{money(row.predecessorCost)}</span>
            {whole ? '' : ` against ${money(row.cost)}`}: {modelName(row.model)} is{' '}
            <span className="cmp">{share(Math.abs(change))}</span> {word} here.{' '}
          </span>
        )
      })}
    </>
  )
}

/** requests that are placeholders, not a model, so "the same tokens" still holds with them in the count */
function realModelsMissing(usage: SplitUsage): number {
  return usage.costByModel.filter((one) => one.model.startsWith('<')).reduce((sum, one) => sum + one.requests, 0)
}
