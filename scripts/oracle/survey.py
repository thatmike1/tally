#!/usr/bin/env python3
"""per-block descriptive table: meter movement against the token mix."""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B
import extract

KINDS = B.KINDS
FAMS = ("opus", "fable", "sonnet", "haiku", "other")


def main():
    bl = B.blocks()
    lo = min(r["t"] for rs in bl.values() for r in rs)
    hi = max(r["t"] for rs in bl.values() for r in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    print(f"{'block':13} {'pts':>4} {'Mtok':>6} {'$':>6} {'pt/Mtok':>8} {'pt/$':>6} | "
          + " ".join(f"{f[:4]:>6}" for f in FAMS) + "   (Mtok share)")
    for reset, rows in bl.items():
        start = reset - 5 * 3600
        m = B.monotonic(rows)
        # only the span the samples actually cover, so tokens outside it are not
        # charged to a meter movement nobody observed
        t0, t1 = m[0]["t"], m[-1]["t"]
        inb = [r for r in recs if t0 <= r["t"] < t1]
        pts = m[-1]["pct"] - m[0]["pct"]
        tok = sum(r[k] for r in inb for k in KINDS)
        cost = sum(r["cost"] for r in inb)
        fam = {f: sum(r[k] for r in inb for k in KINDS if r["fam"] == f) for f in FAMS}
        print(f"{datetime.fromtimestamp(start):%d %b %H:%M} {pts:4.0f} {tok/1e6:6.1f} {cost:6.1f} "
              f"{pts/(tok/1e6) if tok else 0:8.2f} {pts/cost if cost else 0:6.2f} | "
              + " ".join(f"{fam[f]/tok*100 if tok else 0:5.0f}%" for f in FAMS))
    print()
    print("kind mix per block (% of tokens)")
    print(f"{'block':13} " + " ".join(f"{k:>7}" for k in KINDS))
    for reset, rows in bl.items():
        m = B.monotonic(rows)
        inb = [r for r in recs if m[0]["t"] <= r["t"] < m[-1]["t"]]
        tok = sum(r[k] for r in inb for k in KINDS) or 1
        print(f"{datetime.fromtimestamp(reset-5*3600):%d %b %H:%M} "
              + " ".join(f"{sum(r[k] for r in inb)/tok*100:6.1f}%" for k in KINDS))


if __name__ == "__main__":
    main()
