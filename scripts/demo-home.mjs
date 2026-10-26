#!/usr/bin/env node
// writes a made-up home for screenshots and UI checks: three weeks of meter
// samples and the Claude transcripts that moved them, ending at the moment it
// runs. nothing in it comes from a real machine. run the server against it with
//   node scripts/demo-home.mjs /tmp/tally-demo && HOME=/tmp/tally-demo pnpm run serve --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2]
if (!home) {
  console.error('usage: demo-home.mjs <dir>')
  process.exit(2)
}

const MIN = 60
const HOUR = 3600
const DAY = 86400
const now = Math.floor(Date.now() / 1000)
const first = now - 21 * DAY

// a seeded generator, so two runs a minute apart draw the same weeks
let seed = 20261022
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}
const between = (low, high) => low + random() * (high - low)
const pick = (items) => items[Math.floor(random() * items.length)]

const projects = ['demo-shop', 'notes-app', 'tally', 'portfolio']
const titles = [
  'fix the checkout total rounding',
  'add a dark theme to the settings page',
  'why does the build take two minutes',
  'write tests for the csv importer',
  'refactor the session store',
  'draft the release notes',
  'port the chart to svg',
  'clean up the router',
  'review the open pull request',
  'migrate the config to json',
]
const models = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']

// sessions: two to four a day, the last one still running now
const sessions = []
for (let day = first - (first % DAY); day < now; day += DAY) {
  const count = 2 + Math.floor(random() * 3)
  for (let i = 0; i < count; i++) {
    const start = day + Math.floor(between(6, 21) * HOUR)
    const length = Math.floor(between(25 * MIN, 3 * HOUR))
    if (start > now - 10 * MIN || start < first) continue
    sessions.push({ start, end: Math.min(start + length, now - 30), project: pick(projects), title: pick(titles), model: pick(models) })
  }
}
sessions.push({ start: now - 95 * MIN, end: now - 30, project: 'tally', title: 'free zoom and pan on the timeline', model: 'claude-opus-5-5' })

// requests: bursts of work with idle gaps inside each session
const requests = []
let counter = 0
for (const [n, session] of sessions.entries()) {
  session.id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  session.requests = []
  let t = session.start
  while (t < session.end) {
    const burst = t + between(5 * MIN, 40 * MIN)
    for (; t < Math.min(burst, session.end); t += Math.floor(between(15, 90))) {
      const request = { t, session, id: ++counter, points: session.model.includes('sonnet') ? 0.06 : session.model.includes('fable') ? 0.2 : 0.12 }
      session.requests.push(request)
      requests.push(request)
    }
    t += Math.floor(between(8 * MIN, 50 * MIN))
  }
}
requests.sort((a, b) => a.t - b.t)

// the meters, sampled every five minutes the way the sampler reads them
const rows = []
let block = null
let week = null
let next = 0
const weekStart = (t) => t - ((t - 3 * DAY + 2 * HOUR) % (7 * DAY))
for (let t = first; t <= now; t += 5 * MIN) {
  for (; next < requests.length && requests[next].t <= t; next++) {
    const request = requests[next]
    if (!block || request.t >= block.resetsAt) block = { resetsAt: Math.ceil(request.t / HOUR) * HOUR + 4 * HOUR, pct: 0 }
    const opens = weekStart(request.t)
    if (!week || week.start !== opens) week = { start: opens, pct: 0 }
    block.pct = Math.min(100, block.pct + request.points)
    week.pct = Math.min(100, week.pct + request.points / 14)
  }
  if (block && t >= block.resetsAt) block = null
  const opens = weekStart(t)
  if (!week || week.start !== opens) week = { start: opens, pct: 0 }
  rows.push({
    t,
    src: 'api',
    limits: {
      five_hour: block ? { used_percentage: Math.round(block.pct), resets_at: block.resetsAt } : { used_percentage: 0, resets_at: null },
      seven_day: { used_percentage: Math.round(week.pct), resets_at: week.start + 7 * DAY },
    },
  })
}

const cache = join(home, '.cache', 'tally')
mkdirSync(cache, { recursive: true })
writeFileSync(join(cache, 'limits.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

const iso = (t) => new Date(t * 1000).toISOString()
for (const session of sessions) {
  if (!session.requests.length) continue
  const dir = join(home, '.claude', 'projects', `-home-demo-git-${session.project}`)
  mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'user', timestamp: iso(session.start), isSidechain: false, cwd: `/home/demo/git/${session.project}`, message: { role: 'user', content: session.title } },
    ...session.requests.map((request) => ({
      type: 'assistant',
      timestamp: iso(request.t),
      requestId: `req_demo${request.id}`,
      isSidechain: false,
      message: {
        id: `msg_demo${request.id}`,
        model: session.model,
        usage: { input_tokens: 4, cache_creation_input_tokens: 1200, cache_read_input_tokens: 60000, output_tokens: 400 },
      },
    })),
  ]
  writeFileSync(join(dir, `${session.id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

console.log(`${home}: ${rows.length} samples, ${sessions.length} sessions, ${requests.length} requests`)
