#!/usr/bin/env python3
"""which quantity splits a block's meter delta most accurately?

Scored on intervals, because an interval is the only unit with a ground-truth
meter delta. Error is stated in percentage points of the block, which is the unit
the page prints. Weights, where a candidate has them, are fitted leave-one-block
-out so no block scores itself.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alts
import blocks as B
import extract
import fit as F
import linalg

FAMS = F.FAMS
KINDS = F.KINDS
BIN = int(sys.argv[1]) if len(sys.argv) > 1 else 1800


def score(rows, weight_of):
    """weight_of(row) -> a non-negative size; scored as share of its block."""
    errs = []
    per_block = {}
    for reset in sorted({r["block"] for r in rows}):
        sub = [r for r in rows if r["block"] == reset]
        tp = sum(r["dy"] for r in sub)
        tw = sum(weight_of(r) for r in sub) or 1e-9
        e = []
        for r in sub:
            e.append(r["dy"] / tp * 100 - weight_of(r) / tw * 100)
        per_block[reset] = sum(abs(x) for x in e) / len(e)
        errs += e
    n = len(errs)
    return (sum(abs(x) for x in errs) / n, max(abs(x) for x in errs),
            (sum(x * x for x in errs) / n) ** 0.5, per_block)


def lobo_weights(rows, feats, sc):
    """per-block weight vectors, each fitted on the other five blocks."""
    out = {}
    for held in sorted({r["block"] for r in rows}):
        tr = [r for r in rows if r["block"] != held]
        X = [[r[f] / sc for f in feats] for r in tr]
        out[held] = linalg.nnls(X, [r["dy"] for r in tr])
    return out


def main():
    rows = F.dataset(BIN)
    bl = B.blocks()
    lo = min(x["t"] for rs in bl.values() for x in rs)
    hi = max(x["t"] for rs in bl.values() for x in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    alts.enrich(rows, recs)
    for r in rows:
        for k in KINDS:
            r[f"any_{k}"] = sum(r[f"{f}_{k}"] for f in FAMS)

    cands = [("total tokens", lambda r: r["tok"], None),
             ("list-price cost", lambda r: r["cost"], None),
             ("requests", lambda r: r["reqs"], None),
             ("output tokens", lambda r: r["any_out"], None)]
    fitted = [("cost per family", [f"cost_{f}" for f in FAMS], 1.0),
              ("requests per family", [f"req_{f}" for f in FAMS], 100.0),
              ("tokens per family per kind", [f"{f}_{k}" for f in FAMS for k in KINDS], 1e6),
              ("cost + requests per family",
               [f"cost_{f}" for f in FAMS] + [f"req_{f}" for f in FAMS], 1.0)]

    print(f"bin >= {BIN}s, {len(rows)} intervals, {len({r['block'] for r in rows})} blocks")
    print(f"error is in percentage points of the block's own meter delta\n")
    print(f"{'split by':32} {'mean|err|':>9} {'rms':>6} {'max':>6}")
    results = {}
    for name, fn, _ in cands:
        m, mx, rms, pb = score(rows, fn)
        results[name] = pb
        print(f"{name:32} {m:9.2f} {rms:6.2f} {mx:6.1f}")
    for name, feats, sc in fitted:
        W = lobo_weights(rows, feats, sc)
        fn = lambda r, feats=feats, sc=sc, W=W: sum(r[f] / sc * W[r["block"]][i]
                                                    for i, f in enumerate(feats))
        m, mx, rms, pb = score(rows, fn)
        results[name + " (LOBO)"] = pb
        print(f"{name + ' (LOBO)':32} {m:9.2f} {rms:6.2f} {mx:6.1f}")

    print(f"\nmean |error| per block, in points of that block")
    blocks_ = sorted({r["block"] for r in rows})
    print(f"{'split by':32} " + " ".join(f"{datetime.fromtimestamp(b-5*3600):>9%d %H:%M}"
                                         for b in blocks_))
    for name, pb in results.items():
        tot = {b: sum(r["dy"] for r in rows if r["block"] == b) for b in blocks_}
        print(f"{name:32} " + " ".join(f"{pb[b]/100*tot[b]:9.1f}" for b in blocks_))


if __name__ == "__main__":
    main()
