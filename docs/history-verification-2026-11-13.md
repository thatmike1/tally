# Weekly history verification, 13 November 2026

The running `/api/history` includes the laptop mirror and matches an independent
raw-JSONL recount across the desktop, laptop and VPS.

| Week ending (Prague) | Before cost | After cost | Before $/percent | After $/percent | Independent cost | Unique requests |
|---|---:|---:|---:|---:|---:|---:|
| Sat 7 Nov | $596.52421611 | $1209.03310631 | $6.70251928 | $13.58464164 | $1209.03310631 | 15133 |
| Sat 14 Nov, partial | $699.50920188 | $1030.81038028 | $8.32749050 | $12.27155215 | $1030.81038028 | 12073 |

The first week's measured request span is `[1793480521, 1794085021)`.
The second after span is `[1794085324, 1794566226)`. Its before snapshot
ended at 1794565925, five minutes earlier. At that original cutoff, the
corrected recount is $1030.16848728 ($12.26391056 per percent); $0.641893 of
the displayed increase is subsequent work. Both weekly deltas stayed at 89
and 84 points respectively, with 0% Chats.

Laptop requests contributed $650.115542 (8390 requests) and $334.3263036
(3455 requests). The recount also exposed forked session histories already
being counted twice: removing duplicate message ids subtracts $37.6066518
and $3.6670182 from the imported totals. In the first week, 287 duplicated
message ids had identical token buckets across copies. VPS requests also
exist in desktop mirrors, so host subtotals must not be added blindly.

All 12 five-hour blocks starting 6–8 November (UTC dates) match the independent
recount too, with a combined $640.41984. The maximum weekly discrepancy is
floating-point noise below $0.000000001. No raw logs or SQLite database were
reset or rebuilt; the existing incremental index picked up the new mirror.

Reproduce against a fresh saved API response:

```bash
curl -s 127.0.0.1:1337/api/history > /tmp/tally-history.json
python3 scripts/recount-claude.py /tmp/tally-history.json laptop root@46.224.84.191
```

The script reads raw JSONL independently on each host, keeps the last line per
message id, deduplicates host copies and uses the Python oracle's pricing from
the same model map as the server. It reports the last two weeks and preserves
the API response's measured spans, even as new work arrives. It requires all
named hosts to answer; an unavailable source fails the check.

Installed `CLAUDE_SOURCES=laptop=laptop` in the desktop sampler service drop-in;
the existing timer now imports every 15 minutes. A forced copy succeeded and
the service and timer are active. Offline retention, source cadence, mirrored
subagents, copied sessions, forked requests, annotation boundaries/API and chart
rendering are tested. `pnpm test`: 466 passing; `pnpm run typecheck` and
`pnpm run build`: passing. Inspected desktop and 390px history renders: the era
is visible in the weekly list and chart; no document-level horizontal overflow.
