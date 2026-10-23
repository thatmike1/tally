// the sentences the history page writes: a block as one line, a day as a lead,
// a week as its ending, the month against the plan. pure, so every phrasing is
// tested without a browser. null is "not measured" here as everywhere: a block
// with no price per point says why, it never prints a zero.
import type { BlockSummary, WeekSummary, WindowUsage } from '../api'
import { dayKey, money, pct, TZ } from '../format'
import { capital, countWord, modelName, plural } from './words'

const longDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })

/** `friday 16 october`, the dateline's form */
export function longDay(t: number): string {
  return longDate.format(new Date(t * 1000)).replace(',', '').toLowerCase()
}

/** `all Opus`, or `Fable $20.00, Opus $10.00` when no family carried 95% of it */
export function familyPhrase(usage: WindowUsage): string {
  const families = Object.entries(usage.costByFamily)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0.005)
    .sort((a, b) => b[1] - a[1])
  const [top] = families
  if (!top) return ''
  if (top[1] / usage.cost >= 0.95) return `all ${capital(top[0])}`
  return families.map(([family, cost]) => `${capital(family)} ${money(cost)}`).join(', ')
}

/** a block that cost nothing and did not move the meter */
export function isIdle(block: BlockSummary): boolean {
  return block.usage.cost === 0 && (block.delta ?? 0) <= 0
}

/** the block hit the ceiling, read off the meter */
export function ranFull(block: BlockSummary): boolean {
  return block.saturated || block.endPct >= 100
}

export interface BlockLine {
  idle: boolean
  text: string
  /** dollars per meter point, only for a measured block; the page underlines it as computed */
  perPoint: number | null
}

/** one block in a sentence: what it cost, on what, and what a point of it cost or why that is unknown */
export function blockLine(block: BlockSummary): BlockLine {
  if (isIdle(block)) return { idle: true, text: 'idle, nothing ran', perPoint: null }
  const family = familyPhrase(block.usage)
  const spent = `${money(block.usage.cost)} over ${plural(block.usage.sessions, 'session')}${family ? `, ${family}` : ''}`
  if (block.measured && block.dollarsPerPercent !== null) return { idle: false, text: spent, perPoint: block.dollarsPerPercent }
  if (block.saturated) return { idle: false, text: `Ran into 100%, so a point's price is not measured. ${spent}.`, perPoint: null }
  let why = 'it was not measured'
  if (block.delta === null) why = 'One meter reading only'
  else if (block.maxGap > 20 * 60) why = `The sampler missed ${Math.round(block.maxGap / 60)} minutes of it`
  else if (block.delta <= 0) why = 'The meter did not move'
  return { idle: false, text: `${spent}. ${capital(why)}, so no price per point.`, perPoint: null }
}

/** `Two blocks, one ran to 100%. $40.00 at list price.` */
export function dayLead(blocks: BlockSummary[]): string {
  const ran = blocks.filter((block) => !isIdle(block))
  if (!ran.length) return 'Nothing ran.'
  const full = ran.filter(ranFull).length
  const cost = ran.reduce((sum, block) => sum + block.usage.cost, 0)
  const count = ran.length === 1 ? 'One block' : `${capital(countWord(ran.length))} blocks`
  let ending: string
  if (ran.length === 1) ending = full ? ', and it ran to 100%' : ', short of 100%'
  else if (full === 0) ending = ', none ran to 100%'
  else if (full === ran.length) ending = ran.length === 2 ? ', both ran to 100%' : ', all ran to 100%'
  else ending = `, ${countWord(full)} ran to 100%`
  return `${count}${ending}. ${money(cost)} at list price.`
}

/** blocks grouped by the Prague day they started on: newest day first, each day oldest block first */
export function byDay(blocks: BlockSummary[]): { key: string; at: number; blocks: BlockSummary[] }[] {
  const days = new Map<string, { key: string; at: number; blocks: BlockSummary[] }>()
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    const key = dayKey(block.start)
    const day = days.get(key)
    if (day) day.blocks.push(block)
    else days.set(key, { key, at: block.start, blocks: [block] })
  }
  return [...days.values()].reverse()
}

/** the blocks that started inside a weekly window */
export function inWeek(blocks: BlockSummary[], week: Pick<WeekSummary, 'start' | 'resetsAt'>): BlockSummary[] {
  return blocks.filter((block) => block.start >= week.start && block.start < week.resetsAt)
}

/** the cheapest, dearest and middle 5-hour point over every measured block; null when none was */
export function pointRange(blocks: BlockSummary[]): { min: number; max: number; middle: number; count: number } | null {
  const values = blocks
    .filter((block) => block.measured && block.dollarsPerPercent !== null)
    .map((block) => block.dollarsPerPercent!)
    .sort((a, b) => a - b)
  if (!values.length) return null
  const mid = Math.floor(values.length / 2)
  const middle = values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2
  return { min: values[0]!, max: values.at(-1)!, middle, count: values.length }
}

function fableName(week: WeekSummary): string {
  return week.fable.model ? modelName(week.fable.model) : 'Fable'
}

/** `Two blocks ran. The week ended at 60% weekly and 30% fable 5.1, on $300.` */
export function weekLead(week: WeekSummary, blocks: BlockSummary[]): string {
  const ran = blocks.filter((block) => !isIdle(block)).length
  const count = ran === 0 ? 'No block ran.' : ran === 1 ? 'One block ran.' : `${capital(countWord(ran))} blocks ran.`
  const fable = week.fable.endPct === null ? '' : ` and ${pct(week.fable.endPct)} ${fableName(week)}`
  const verb = week.partial ? 'stands' : 'ended'
  return `${count} The week ${verb} at ${pct(week.endPct)} weekly${fable}, on ${money(week.usage.cost)}.`
}

/** `The last two finished weeks ended at 83% and 81%, with fable 5.1 at 30% and 30%.` */
export function finishedWeeks(weeks: WeekSummary[]): string {
  const done = weeks.filter((week) => !week.partial).slice(-2).reverse()
  if (!done.length) return 'No week has finished since the first reading.'
  const ends = done.map((week) => pct(week.endPct))
  const fables = done.every((week) => week.fable.endPct !== null)
    ? `, with ${fableName(done[0]!)} at ${done.map((week) => pct(week.fable.endPct!)).join(' and ')}`
    : ''
  const lead = done.length === 1 ? 'The one finished week ended at' : 'The last two finished weeks ended at'
  return `${lead} ${ends.join(' and ')}${fables}.`
}

/** the month's list-price use against the plan, as a verdict */
export function planVerdict({ monthCost, planUsd }: { monthCost: number; planUsd: number }): { tone: string; head: string; rest: string } {
  if (monthCost >= planUsd) return { tone: 'ok', head: 'It pays for itself.', rest: '' }
  return { tone: '', head: 'Not yet the price.', rest: `${money(planUsd - monthCost)} of list-price use to go this month.` }
}
