#!/usr/bin/env python3
"""the weekly meters as an independent check on the same transcripts.

The weekly window covers the whole sampled span with no block boundary inside
it, so its series is one long monotone climb. The Fable meter is scoped to one
model, which isolates a single price point that the 5h meter can only see mixed.
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B
import extract

KINDS = B.KINDS


def main():
    s = [r for r in B.samples() if r["wk"] is not None]
    lo, hi = s[0]["t"], s[-1]["t"]
    recs = extract.records(lo - 24 * 3600, hi + 60)
    fab = [r for r in recs if r["fam"] == "fable"]
    print(f"weekly series {datetime.fromtimestamp(lo):%d %b %H:%M} -> "
          f"{datetime.fromtimestamp(hi):%d %b %H:%M}, {len(s)} samples")
    print(f"{'time':11} {'7d%':>5} {'fable%':>7} | {'all $':>8} {'fable $':>8} "
          f"{'all Mtok':>9} {'fab Mtok':>9} | {'$/7dpt':>7} {'fab$/pt':>8}")
    prev = None
    for r in s:
        if prev and r["t"] - prev["t"] < 1800 and r is not s[-1]:
            continue
        inb = [x for x in recs if lo <= x["t"] < r["t"]]
        f = [x for x in inb if x["fam"] == "fable"]
        d7 = r["wk"] - s[0]["wk"]
        df = r["scoped"].get("Fable", 0) - s[0]["scoped"].get("Fable", 0)
        c = sum(x["cost"] for x in inb)
        cf = sum(x["cost"] for x in f)
        print(f"{datetime.fromtimestamp(r['t']):%d %b %H:%M} {r['wk']:5.0f} "
              f"{r['scoped'].get('Fable', 0):7.0f} | {c:8.1f} {cf:8.1f} "
              f"{sum(x[k] for x in inb for k in KINDS)/1e6:9.1f} "
              f"{sum(x[k] for x in f for k in KINDS)/1e6:9.1f} | "
              f"{c/d7 if d7 else 0:7.2f} {cf/df if df else 0:8.2f}")
        prev = r


if __name__ == "__main__":
    main()
