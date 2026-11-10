#!/usr/bin/env python3
"""5-hour blocks from the meter log, cleaned, with the transcripts beside them."""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract

LOG = os.path.expanduser("~/.cache/cc-browse-tray/limits.jsonl")
KINDS = ("in", "cw1h", "cw5m", "cr", "out")


def samples(src_filter="api"):
    """meter readings, newest write per timestamp, sorted.

    `src` tells the api sampler from the statusline hook. The statusline payload
    is whatever that terminal last heard from the API, so an idle tab redrawn
    later republishes a stale, lower number; the api sampler reads the endpoint
    itself every five minutes. Only api rows are trusted for the fit.
    """
    out = []
    for line in open(LOG):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if src_filter and r.get("src") != src_filter:
            continue
        fh = r["limits"].get("five_hour") or {}
        if not fh.get("resets_at"):
            continue
        out.append({
            "t": r["t"],
            "pct": float(fh["used_percentage"]),
            # resets_at jitters by a second between samples of the same block
            "reset": round(fh["resets_at"] / 60) * 60,
            "wk": (r["limits"].get("seven_day") or {}).get("used_percentage"),
            "scoped": {s["model"]: s["percent"] for s in (r.get("scoped") or [])},
        })
    out.sort(key=lambda r: r["t"])
    return out


def blocks(src_filter="api"):
    by = {}
    for s in samples(src_filter):
        by.setdefault(s["reset"], []).append(s)
    return dict(sorted(by.items()))


def monotonic(rows):
    """within a block the meter only climbs; a lower reading is stale."""
    kept, high = [], -1.0
    for r in rows:
        if r["pct"] >= high:
            high = r["pct"]
            kept.append(r)
    return kept


def main():
    bl = blocks()
    all_start = min(r["t"] for rs in bl.values() for r in rs)
    all_end = max(r["t"] for rs in bl.values() for r in rs)
    recs = extract.records(all_start - 3600, all_end + 3600)
    print(f"{len(recs)} requests parsed over the whole sampled span")
    # duplicate message ids across files: a resumed session copies history
    seen = {}
    dups = 0
    for r in recs:
        if r["mid"] in seen and seen[r["mid"]] != r["file"]:
            dups += 1
        seen[r["mid"]] = r["file"]
    print(f"message ids appearing in more than one file: {dups}")
    unp = [r for r in recs if not r["priced"]]
    print(f"unpriced models: {sorted({r['model'] for r in unp})} ({len(unp)} requests)")
    print()
    hdr = f"{'block start':16} {'reset':6} {'n':>3} {'raw':>7} {'mono':>5} {'gapmax':>7} {'reqs':>5} {'Mtok':>8} {'$':>7}"
    print(hdr)
    for reset, rows in bl.items():
        start = reset - 5 * 3600
        m = monotonic(rows)
        gaps = max((b["t"] - a["t"]) for a, b in zip(m, m[1:])) if len(m) > 1 else 0
        inb = [r for r in recs if start <= r["t"] < reset]
        tok = sum(r[k] for r in inb for k in KINDS)
        cost = sum(r["cost"] for r in inb)
        print(f"{datetime.fromtimestamp(start):%d %b %H:%M} {datetime.fromtimestamp(reset):%H:%M} "
              f"{len(rows):3d} {rows[0]['pct']:3.0f}->{rows[-1]['pct']:3.0f} {m[-1]['pct'] - m[0]['pct']:5.0f} "
              f"{gaps / 60:6.0f}m {len(inb):5d} {tok / 1e6:8.1f} {cost:7.2f}")


if __name__ == "__main__":
    main()
