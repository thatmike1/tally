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
`~/.t3/userdata/widgets/tally.json` every minute), then rows that open tally,
cc-browse, bd-board and AgentsView and start or stop cc-browse and AgentsView.
`tray/tally-tray.py --print` dumps the label and rows. Which sessions ate the
block stays on the page.

Flags: `--port <n>`, `--ccbrowse <url>`, `--no-ccbrowse`, `--no-open`,
`--no-widget`, `--no-takeaway` (the focused, visible page requests the takeaway
through an `agy -p` call, then it is served from memory at `/api/takeaway`).
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

**The day lanes** — cc-browse's running server, `GET /api/timeline`, at
`http://127.0.0.1:4173` by default. **This is a dependency on another process.**
Fold it in later, or accept that the lanes section is empty when cc-browse is
down (it says so rather than disappearing). `--no-ccbrowse` turns the lookup off.

**Codex weekly** — the server spawns `codex app-server` every five minutes and
asks `account/rateLimits/read` for the main bucket's seven-day window, with no
conversation or model turn. Readings go to `~/.cache/tally/codex-usage.jsonl`,
the last read's outcome to `codex-usage-status.json`; neither holds credentials.
A reading older than 15 minutes or a failed read shows as stale, never as 0%.
The pace is the week's average burn: the meter is cumulative since the window
opened (reset minus seven days), so the latest reading alone gives it and a gap
in the history does not bias it. No projection until a full day of the week has
passed, or when the meter went down inside the week. It shares nothing with the
Claude cost model and attributes nothing to threads.

**Non-Claude threads** — T3 Code's `~/.t3/userdata/state.sqlite`, opened
read-only because T3 is running and writing to it. Antigravity, Codex and
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
