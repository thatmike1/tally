#!/usr/bin/env python3
"""how wrong is "share of the block's cost" as a stand-in for "share of the
block's points"?

Ground truth per session does not exist, but ground truth per *interval* does:
the meter delta over that interval. So score the share model on intervals, and
again on the coarser unit the page actually draws, a run of intervals dominated
by one session.

Also tests convexity: if late work inside a block moves the meter more than early
work of the same size, no share-of-cost split can be right.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alts
import blocks as B
import extract
import fit as F

BIN = int(sys.argv[1]) if len(sys.argv) > 1 else 1800


def main():
    rows = F.dataset(BIN)
    bl = B.blocks()
    lo = min(x["t"] for rs in bl.values() for x in rs)
    hi = max(x["t"] for rs in bl.values() for x in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    alts.enrich(rows, recs)

    print(f"bin >= {BIN}s\n")
    print("share of the block's points vs share of the block's cost, per interval")
    print(f"{'block':13} {'int':>4} {'pts':>5} {'act%':>6} {'cost%':>6} {'err pp':>7} {'half':>5}")
    errs, errs_first, errs_last = [], [], []
    for reset in sorted({r["block"] for r in rows}):
        sub = [r for r in rows if r["block"] == reset]
        tp = sum(r["dy"] for r in sub)
        tc = sum(r["cost"] for r in sub) or 1e-9
        mid = (sub[0]["t0"] + sub[-1]["t1"]) / 2
        for i, r in enumerate(sub):
            a = r["dy"] / tp * 100
            p = r["cost"] / tc * 100
            half = "1st" if r["t0"] < mid else "2nd"
            errs.append(a - p)
            (errs_first if half == "1st" else errs_last).append(a - p)
            print(f"{datetime.fromtimestamp(reset-5*3600):%d %b %H:%M} {i:4d} {r['dy']:5.0f} "
                  f"{a:6.1f} {p:6.1f} {a-p:+7.1f} {half:>5}")
    n = len(errs)
    print(f"\nper-interval share error: mean {sum(errs)/n:+.2f} pp, "
          f"mean |err| {sum(abs(e) for e in errs)/n:.2f} pp, "
          f"max |err| {max(abs(e) for e in errs):.1f} pp")
    print(f"  first half of a block: mean {sum(errs_first)/len(errs_first):+.2f} pp "
          f"({len(errs_first)} intervals)")
    print(f"  second half of a block: mean {sum(errs_last)/len(errs_last):+.2f} pp "
          f"({len(errs_last)} intervals)")
    print("  a positive second-half mean means late work moves the meter more "
          "than its cost share, i.e. the block is convex and a flat share split "
          "under-charges whatever ran late.")

    # convexity, stated as a number: cumulative points share vs cumulative cost
    # share at the block midpoint
    print("\nconvexity per block: at the halfway point of the block's cost, how "
          "much of its points had the meter already spent?")
    print(f"{'block':13} {'pts@50% cost':>13}")
    for reset in sorted({r["block"] for r in rows}):
        sub = [r for r in rows if r["block"] == reset]
        tp, tc = sum(r["dy"] for r in sub), sum(r["cost"] for r in sub)
        cc = cp = 0.0
        got = None
        for r in sub:
            cc += r["cost"]
            cp += r["dy"]
            if got is None and cc >= tc / 2:
                got = cp / tp * 100
        print(f"{datetime.fromtimestamp(reset-5*3600):%d %b %H:%M} {got:12.0f}%")
    print("  50% would be a straight line; below 50% means the meter accelerates "
          "later in the block.")


if __name__ == "__main__":
    main()
