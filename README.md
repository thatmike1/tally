# tally

A local page that answers "I'm suddenly at 60% of my 5-hour limit, what ate it"
in three seconds. Successor to cc-browse's live/lanes view and usage-burn, fused.

The design record lives in `~/git/ccChat-general/projects/tally`: `sketch.md` for
the decisions, `mock.html` for the accepted picture (v4), `attribution-proof.md`
for the maths behind every number here.

## Run it

```
npm install
npm start          # builds the ui, serves on 127.0.0.1:1337, opens the browser
```

Other scripts:

| command | what it does |
|---|---|
| `npm run dev` | tsx watch on the server plus the vite dev server on 5174 |
| `npm run serve` | the server alone, against the already-built ui |
| `npm test` | vitest, including the comparison against the python oracle |
| `npm run typecheck` | tsc over server and ui |
| `npm run oracle` | regenerate the expected tables from `jobs/*.py` (see Tests) |

## As a service

`systemd/install.sh` builds the ui and enables `systemd/tally.service` as a user
unit (linked from this repo, so edits apply after `systemctl --user daemon-reload`).
It serves the built `ui/dist`, so after ui changes run `npm run build` and
`systemctl --user restart tally`.

`systemd/tally-tray.service` runs `tray/tally-tray.py`, a GNOME tray icon with
the three meter lines (the same text the server writes to the T3 widget at
`~/.t3/userdata/widgets/tally.json` every minute), then rows that open tally and
bd-board, and open, start or stop AgentsView. `tray/tally-tray.py --print` dumps
the label and rows. Which sessions ate the block stays on the page.

Flags: `--port <n>`, `--no-open`, `--no-widget`, `--no-takeaway` (the focused,
visible page requests the takeaway through an `agy -p` call, then it is served
from memory at `/api/takeaway`).
`bin/tally.mjs` is a launcher that works from any directory, so
`ln -s ~/git/tally/bin/tally.mjs ~/.local/bin/tally` is enough to run it anywhere.

## Where the numbers come from

**The meters** — `~/.cache/cc-browse-tray/limits.jsonl`, written by
`projects/usage-burn/usage-sample.py` off `GET /api/oauth/usage` on a five-minute
systemd timer. Only rows with `"src": "api"` are read: the statusline hook writes
the same shape, but a payload republished by an idle terminal is stale, and 26%
of those rows disagreed with the API by two points or more. Blocks are keyed on
`round(resets_at / 60)` because `resets_at` jitters by a second, and a reading
lower than the one before it inside a block is dropped as stale.

If the page says the sampler is behind, check
`systemctl --user list-timers usage-sample.timer`.

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

**Codex weekly** — the server spawns `codex app-server` every five minutes and
asks `account/rateLimits/read` for the main bucket's seven-day window, with no
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

**Transcript links** go to AgentsView, `http://127.0.0.1:8080/sessions/<id>?msg=last`.

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

`npm test`. The interesting ones compare against the python that produced the
proof:

- `server/transcripts.test.ts` — every request must match `jobs/extract.py`'s own
  output over `test/fixtures/home`, field by field.
- `server/blocks.test.ts` — every block's points, tokens and list cost must match
  `jobs/survey.py`'s printed table over the same fixture.

Both fixtures are frozen in `test/fixtures/`. The transcripts there are real ones
with every message body stripped out; only the fields both parsers read survive.
Rebuild them with `python3 scripts/make-fixtures.py` and then `npm run oracle`,
which needs the proof scripts (`TALLY_JOBS`, default
`~/git/ccChat-general/projects/tally/jobs`).

## Not in v1

The tray face, the T3 sidebar widget, the Gemini one-liner over the split, and
any transcript rendering. `docs/v1.png` is what v1 looks like.
