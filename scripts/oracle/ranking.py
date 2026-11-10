#!/usr/bin/env python3
"""does the cost split at least get the order right, and does the meter ever
move with nothing running locally?

Ranking is the page's primary job: "which session ate the jump". A split can be
numerically loose and still answer that.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alts
import blocks as B
import extract
import fit as F


def main():
    bl = B.blocks()
    lo = min(x["t"] for rs in bl.values() for x in rs)
    hi = max(x["t"] for rs in bl.values() for x in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)

    for bs in (900, 1800, 3600):
        rows = F.dataset(bs)
        alts.enrich(rows, recs)
        top1 = pairs = conc = 0
        blocks_ = sorted({r["block"] for r in rows})
        for reset in blocks_:
            sub = [r for r in rows if r["block"] == reset]
            if max(r["dy"] for r in sub) == 0:
                continue
            top1 += (max(sub, key=lambda r: r["dy"]) is max(sub, key=lambda r: r["cost"]))
            for i in range(len(sub)):
                for j in range(i + 1, len(sub)):
                    a, b = sub[i], sub[j]
                    if a["dy"] == b["dy"] or a["cost"] == b["cost"]:
                        continue
                    pairs += 1
                    conc += (a["dy"] > b["dy"]) == (a["cost"] > b["cost"])
        print(f"bin {bs:5d}s: top-1 interval identified by cost in {top1}/{len(blocks_)} blocks, "
              f"pairwise order agrees {conc}/{pairs} = {conc/pairs*100:.0f}%")

    print()
    for bs in (600, 900, 1800):
        rows = F.dataset(bs)
        alts.enrich(rows, recs)
        tot = sum(r["dy"] for r in rows)
        ghost = [r for r in rows if r["reqs"] == 0 and r["dy"] > 0]
        idle = [r for r in rows if r["reqs"] == 0]
        print(f"bin {bs:5d}s: {len(idle)}/{len(rows)} intervals had no local request; "
              f"{len(ghost)} of those still moved the meter, "
              f"{sum(r['dy'] for r in ghost):.0f} of {tot:.0f} pts "
              f"({sum(r['dy'] for r in ghost)/tot*100:.1f}%)")
        for r in ghost:
            print(f"    {datetime.fromtimestamp(r['t0']):%d %b %H:%M}-"
                  f"{datetime.fromtimestamp(r['t1']):%H:%M} +{r['dy']:.0f} pts")


if __name__ == "__main__":
    main()
