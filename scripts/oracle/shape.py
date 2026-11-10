#!/usr/bin/env python3
"""cumulative meter against cumulative cost inside each block.

If the relation is a straight line through the block's own origin, a per-block
constant is all the page needs. A curve means the meter is not a running sum of
anything the transcripts hold.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B
import extract


def main():
    bl = B.blocks()
    lo = min(x["t"] for rs in bl.values() for x in rs)
    hi = max(x["t"] for rs in bl.values() for x in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    for reset, raw in bl.items():
        m = B.monotonic(raw)
        if len(m) < 6:
            continue
        t0 = m[0]["t"]
        print(f"\n=== block {datetime.fromtimestamp(reset-5*3600):%d %b %H:%M} ===")
        print(f"{'time':6} {'5h%':>4} {'d%':>4} {'cum$':>7} {'cum pts/$':>10} "
              f"{'cumMtok':>8} {'pts/Mtok':>9}")
        prev = None
        for r in m:
            if prev and r["t"] - prev < 1500 and r is not m[-1]:
                continue
            prev = r["t"]
            inb = [x for x in recs if t0 <= x["t"] < r["t"]]
            c = sum(x["cost"] for x in inb)
            tk = sum(x[k] for x in inb for k in B.KINDS) / 1e6
            d = r["pct"] - m[0]["pct"]
            print(f"{datetime.fromtimestamp(r['t']):%H:%M} {r['pct']:4.0f} {d:4.0f} "
                  f"{c:7.1f} {d/c if c else 0:10.3f} {tk:8.1f} {d/tk if tk else 0:9.2f}")


if __name__ == "__main__":
    main()
