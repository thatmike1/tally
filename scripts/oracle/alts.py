#!/usr/bin/env python3
"""alternative feature sets, in case the meter is not a token sum at all."""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B
import extract
import fit as F
import linalg
import withinblock as W

FAMS = F.FAMS
KINDS = F.KINDS
BIN = int(sys.argv[1]) if len(sys.argv) > 1 else 1800


def enrich(rows, recs):
    for r in rows:
        inb = [x for x in recs if r["t0"] <= x["t"] < r["t1"]]
        r["reqs"] = len(inb)
        for f in FAMS:
            sel = [x for x in inb if x["fam"] == f]
            r[f"req_{f}"] = len(sel)
            # context size at request time: cache read is the prompt that was
            # already cached, so read+write+in is roughly the prompt length
            r[f"prompt_{f}"] = sum(x["in"] + x["cr"] + x["cw1h"] + x["cw5m"] for x in sel)
        for k in KINDS:
            r[f"any_{k}"] = sum(r[f"{f}_{k}"] for f in FAMS)
        r["secs"] = r["t1"] - r["t0"]
    return rows


def main():
    rows = F.dataset(BIN)
    bl = B.blocks()
    lo = min(x["t"] for rs in bl.values() for x in rs)
    hi = max(x["t"] for rs in bl.values() for x in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    enrich(rows, recs)
    cands = [
        ("requests", ["reqs"], 100.0),
        ("requests per family", [f"req_{f}" for f in FAMS], 100.0),
        ("prompt tokens per family", [f"prompt_{f}" for f in FAMS], 1e6),
        ("output tokens per family", [f"{f}_out" for f in FAMS], 1e6),
        ("out + cache-write per family", [f"{f}_{k}" for f in FAMS for k in ("out", "cw1h", "cw5m")], 1e6),
        ("cost + requests", ["cost", "reqs"], 1.0),
        ("cost per family + requests", [f"cost_{f}" for f in FAMS] + ["reqs"], 1.0),
        ("wall clock only", ["secs"], 3600.0),
        ("cost + wall clock", ["cost", "secs"], 1.0),
        ("list-price cost (baseline)", ["cost"], 1.0),
    ]
    print(f"bin >= {BIN}s, {len(rows)} intervals, {len({r['block'] for r in rows})} blocks")
    print(f"{'features':34} {'globR2':>7} {'globRMSE':>9} {'normR2':>7} {'normRMSE':>9} {'normMAE':>8}")
    for name, feats, sc in cands:
        X = [[r[f] / sc for f in feats] for r in rows]
        y = [r["dy"] for r in rows]
        w = linalg.nnls(X, y)
        g = linalg.stats(X, y, w)
        n = W.norm_eval(rows, feats, sc, w)
        print(f"{name:34} {g['r2']:7.3f} {g['rmse']:9.2f} {n['r2']:7.3f} {n['rmse']:9.2f} {n['mae']:8.2f}")


if __name__ == "__main__":
    main()
