# tally

A local page that answers "I'm suddenly at 60% of my 5-hour limit, what ate it"
in three seconds, and keeps every past block so you can see what a meter point
actually costs you.

Ubuntu (or Windows, see [Windows](#windows)), a Claude subscription, Node 22+
and Python 3. Everything else is
optional and detected: Codex, AgentsView, T3 Code, and whatever local
pages you want in the tray.

## Install

```
git clone https://github.com/thatmike1/tally && cd tally
systemd/install.sh
```

That installs dependencies, builds the ui, and enables three user units:
`tally.service` (the page on 127.0.0.1:1337), `tally-sampler.timer` (reads your
account meters every five minutes) and `tally-tray.service` (the GNOME tray
icon). It also writes `~/.config/tally/config.json` from what it finds on the
machine, once — after that the file is yours and install never touches it again.
Re-running is safe. `systemd/uninstall.sh` takes the units back off and leaves
the cache and config alone.

**The sampler is the part that matters.** `sampler/usage-sample.py` asks
`GET /api/oauth/usage` with your existing Claude OAuth token from
`~/.claude/.credentials.json`, costs no tokens, and appends one row to
`~/.cache/tally/limits.jsonl`. Without it tally has nothing to draw, so a fresh
install shows an honest empty page until the first sample lands five minutes
later, and the history page fills in over a day or two. Nothing is backfilled:
tally only knows what the sampler saw.

## Configuration

`~/.config/tally/config.json`. Every key is optional and every missing one falls
back, so you can delete the file and tally still runs.

| key | default | what it does |
|---|---|---|
| `port` | `1337` | where the page listens |
| `plan` | `{"name": "Max 5x", "usdPerMonth": 100}` | what "the sub is worth" compares your list-price usage against |
| `codexPlan` | `{"name": "ChatGPT Pro", "usdPerMonth": 100}` | the same for the Codex history tab |
| `agentsviewUrl` | `null` | base url of a local AgentsView. `null` means no transcript links are drawn at all, rather than dead ones |
| `tray.links` | `[]` | rows that open a local page, starting the row's unit if the port is closed |
| `tray.toggles` | `[]` | rows that start *and stop* a unit, for a service that costs something while it runs |
| `python` | `null` | the python 3 that runs the sampler where the server runs it itself (Windows): a command or full path, no arguments. `null` tries `python`, then `py -3` |

The `links` / `toggles` split is the whole tray design: beadside is an always-on
service, so its row is just "open it". AgentsView costs about 7% of a core while
sessions are writing, so its row starts and stops it.

Tally reads this file once at startup; the tray re-reads it on Refresh. Three
programs share the shape (the server, the tray and the installer), so adding a
key means touching `server/config.ts`, `tray/tally-tray.py` and
`systemd/install.sh` together.

## Running it by hand

```
pnpm install --frozen-lockfile
pnpm start          # builds the ui, serves on 127.0.0.1:1337, opens the browser
```

Use pnpm 12.15.0 (pinned in `packageManager`) with Node.js 22 or newer.
Install pnpm with the [standalone installer](https://pnpm.io/installation).

| command | what it does |
|---|---|
| `pnpm run dev` | tsx watch on the server plus the vite dev server on 5174 |
| `pnpm run serve` | the server alone, against the already-built ui |
| `pnpm test` | vitest, including the comparison against the python oracle |
| `pnpm run typecheck` | tsc over server and ui |
| `pnpm run oracle` | regenerate the expected tables from the proof scripts (see Tests) |

The service serves the built `ui/dist`, so after ui changes run `pnpm run build`
and `systemctl --user restart tally`.

Flags: `--port <n>` (wins over the config), `--no-open`, `--no-widget`.
`bin/tally.mjs` is a launcher that works from any directory, so
`ln -s "$PWD/bin/tally.mjs" ~/.local/bin/tally` is enough to run it anywhere.

`tray/tally-tray.py --print` dumps the tray label and rows without a tray, which
is the fastest way to see what a given config produces; `TALLY_CONFIG=/tmp/c.json`
points it at a scratch file.

## Windows

There is no installer and no tray on Windows; tally is one process you start
and stop yourself. With no systemd to put the sampler on a timer, the server
runs `sampler/usage-sample.py` itself on the same wall-clock five-minute marks,
one run at a time, and once at startup when the newest reading is already five
minutes old. It uses the config's `python`, else `python`, else `py -3`, and
skips anything that does not answer as Python 3 (the Microsoft Store stub).
Sampler failures land in the server's own output.

```
pnpm install --frozen-lockfile
pnpm run build
node --import file:///C:/path/to/tally/node_modules/tsx/dist/loader.mjs C:\path\to\tally\server\main.ts --no-open
```

That command is the whole of tally in one `node.exe` and works from any
directory. `pnpm run serve` and `bin/tally.mjs` work too, but each starts a
second node process under the first, so killing the outer one leaves the
server running. Write `%USERPROFILE%\.config\tally\config.json` by hand if
you want one (the table above); everything else lives where it does on Linux,
under `%USERPROFILE%\.cache\tally`, `.claude`, `.codex` and `.t3`. Ctrl-C and
Ctrl-Break stop it cleanly; a hard kill (`Stop-Process`, `taskkill /F`) skips
the cleanup, so the T3 sidebar keeps the last widget until the next start.

## Routes and endpoints

The page is a hash router: `#/` is today, `#/history` the overview of every
5-hour block and weekly window, `#/history/block/<resetKey>` and
`#/history/week/<resetsAt>` the drill-in that redraws today's page frozen at that
window's last meter sample, and `#/session/<id>` one session on the clock. Behind
them: `GET /api/history` (Claude blocks, weeks and the sub-value line),
`GET /api/history/codex` (Codex windows, credits per point and api list cost),
`GET /api/session/<id>` (one session's requests, parent and subagents apart) and
`GET /api/state?at=<unix seconds>`, which answers with the page as it stood at
that instant: no sample, reading, call or index entry later than `at` is used,
and the "since you last looked" marker is neither read nor written.

## Where the numbers come from

Claude prices include Sonnet 5.5's $0.10/M cache reads and Haiku 5.5's
request-level 100,000-token prompt threshold. Cache reads and writes count
towards the prompt threshold; output tokens do not. Stored transcript costs
are recalculated from their original token buckets when the price table changes.

Codex speed comes from recorded rollout tiers or T3's per-turn event history,
including child agents through their root turn. Fast (`fast` or `priority`)
costs 2x purchased credits and API list prices; its weight in the included
allowance split is 2.5x. A later speed selection never reprices an earlier
turn. Calls without a recorded speed use standard estimates and are flagged
on the page. Today's CLI config is not used to guess old turns' speeds.

**The meters** — `~/.cache/tally/limits.jsonl`, written by
`sampler/usage-sample.py` off `GET /api/oauth/usage` on a five-minute systemd
timer. Only rows with `"src": "api"` are read: a Claude Code statusline hook can
write the same shape, but a payload republished by an idle terminal is stale, and
26% of those rows disagreed with the API by two points or more. Blocks are keyed
on `round(resets_at / 60)` because `resets_at` jitters by a second, and a reading
lower than the one before it inside a block is dropped as stale.

The history starts at the first sample in the log, not at a fixed date, so the
page never claims to know about a day nobody sampled.

If the page says the sampler is behind, check
`systemctl --user list-timers tally-sampler.timer`.

`USAGE_UPSTREAM=user@host` on the sampler unit makes that machine the sampler and
this one copy its log over ssh, asking the endpoint itself only when the
upstream's newest sample is stale. That is for a second machine (a VPS that is up
overnight) on the same account: the endpoint answers 429 when two machines ask at
once, and a 24/7 sampler leaves no holes where background agents ran.

The same upstream's Codex rollouts are mirrored too, every 15 minutes after the
sample, with `rsync --append-verify` from its `~/.codex/sessions/` into
`~/.cache/tally/codex-upstream/`. The Codex meter is account-wide, so without
them a week of agents run over there shows up as meter points with no calls
behind them. The copy stays out of `~/.codex/sessions` so `codex resume` does
not list threads that cannot run here, and a call seen in both places counts
once. `CODEX_UPSTREAM=` (empty) on the unit turns the copy off, and
`CODEX_UPSTREAM=user@host` copies from a machine other than the meter's
upstream. Those calls carry no speed (the speed comes from this machine's T3
state), so they count at standard rate under the unknown-speed caveat.

**Per-request tokens and cost** — `~/.claude/projects/*/*.jsonl` plus
`*/subagents/*.jsonl`, last line per (file, message id), subagent files folded
into the parent session. The price table is cc-browse's, to the cent.

**The transcript index** — `~/.cache/tally/transcripts.sqlite`, one row per
transcript file keyed on its path with the mtime and size that were parsed, plus
one row per request. A file whose mtime and size still match is never reread, so
every pass after the first costs a stat per file. The first build reads the whole
tree (9.8 GB, 6531 files on 16 Sep 2026) in the background, newest file first, so
the block the page is showing is indexed within seconds; `index` in `/api/state`
carries its progress and the page says it is building. Until the build has
reached back past a window's start, that window is read with a live `scan()`
instead, exactly as v1 read every window. Deleting the file costs a rebuild and
nothing else.

**The day lanes** — the same index. A lane is activity, not span: requests
closer than five minutes merge into one segment, and a segment is drawn thicker
where subagent transcripts were writing inside it, so a session that idled three
hours no longer looks like a three-hour eater. Rows are grouped by project,
brightness is the session's cost, and a click opens `#/session/<id>`, whose data
comes from `GET /api/session/:id` (the lead transcript and one lane per subagent
file, with every request on it).

**Codex weekly** — with no `codex` binary on the machine the whole Codex surface
is hidden rather than shown as permanently unavailable. With one, the server
spawns `codex app-server` every five minutes and asks
`account/rateLimits/read` for the main bucket's seven-day window, with no
conversation or model turn. Readings go to `~/.cache/tally/codex-usage.jsonl`,
the last read's outcome to `codex-usage-status.json`; neither holds credentials.
A reading older than 15 minutes or a failed read shows as stale, never as 0%.
The pace is counted in Prague workdays, weekends free: each weekday left before
the reset burns a typical day, and the reset day counts for the part before the
reset. The typical day is the median of this window's fully read weekdays (a
reading within three hours of both midnights); until one exists it is today so
far and the verdict says `provisional`. No verdict on a weekend with no workday
read, when the reader missed the start of today, or when the meter went down
inside the week. It shares nothing with the
Claude cost model and attributes nothing to threads.

**Codex threads** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Every model
call writes a `token_usage_record` (tokens and a response id) and a `token_count`
event with the weekly reading OpenAI returned for it. The week's movement is
split across root threads by credits, priced per model from the Codex rate card
(`CODEX_RATES` in `server/codex-sessions.ts`, read 15 Sep 2026). Subagent
rollouts fold into their root, a forked subagent's copied history is left to its
parent, and threads routed to another provider are dropped. Titles come from T3
(`provider_session_runtime.resume_cursor_json.threadId`), else the first typed
prompt. The caption shows how many credits single points actually took this week.

**Whole week** — the week section's toggle (`/api/state?week=whole`) splits the
weekly and Fable meters since their reset instead of since the last look, with
a zero reading at the reset since both meters open at 0.

**Non-Claude threads** — T3 Code's `~/.t3/userdata/state.sqlite`, opened
read-only because T3 is running and writing to it. Antigravity and
opencode threads get a title, a span and a live tag. They never get points: there
is no usage data for them and none is invented, and the page says the split is
Claude only.

**Transcript links** go to AgentsView, `<agentsviewUrl>/sessions/<id>?msg=last`.
With no `agentsviewUrl` configured no link is drawn anywhere, because a dead link
is worse than none.

## What the split can claim

No mapping from tokens to 5-hour points exists. The same list dollar bought
between 0.74 and 1.82 points across six measured blocks, and weights fitted on
five of them mispredict the sixth by up to 64%. So tally never computes points
from tokens. It divides the delta the samples actually measured, in proportion to
each session's list-price cost over the same span, and headlines the **share** —
share-of-cost tracks share-of-points to about 3.3 percentage points per 30-minute
stretch and gets the ordering right 88-90% of the time.

A points figure appears only as a rounded `~` convenience with the caveat beside
it, and only where a delta was measured. Work that ran before the block's first
sample, after its last one, or inside a sampler gap gets no points at all; the
page prints what that work cost in dollars instead of guessing.

## The weekly verdict is provisional

`weeklyVerdict` in `server/split.ts` compares the points left on a weekly meter
against this account's typical full working day — the median of the last few
weekday deltas of that same meter, weekends excluded because a weekend is free
burn. It returns one of "on pace", "a full <model> day fits", "one light day
left" and "over pace".

This rule has not been judged on a real week yet. It is one small function with
that comment on it so it can be replaced without touching anything else.

## Tests

`pnpm test`. The interesting ones compare against the python that produced the
proof:

- `server/transcripts.test.ts` — every request must match `jobs/extract.py`'s own
  output over `test/fixtures/home`, field by field.
- `server/blocks.test.ts` — every block's points, tokens and list cost must match
  `jobs/survey.py`'s printed table over the same fixture.

Both fixtures are frozen in `test/fixtures/`. The transcripts there are real ones
with every message body stripped out; only the fields both parsers read survive.
Rebuild them with `python3 scripts/make-fixtures.py` and then `pnpm run oracle`,
which needs the proof scripts that produced the attribution numbers
(`TALLY_JOBS`; they are not in this repo, so the oracle refresh only runs where
they are and `pnpm test` never needs them — the fixtures it compares against are
checked in).

## Screenshots

`docs/v5-history.png` is the history page against the demo home
(`scripts/demo-home.mjs`). `docs/v1.png` and `docs/v2-week.png` are earlier
versions: no tray face, no T3 sidebar widget, no Codex. Tally renders no
transcripts itself and never will; that is AgentsView's job.
