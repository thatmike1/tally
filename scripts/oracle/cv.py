#!/usr/bin/env python3
"""leave-one-block-out cross-validation.

With six blocks and up to twenty free weights, an in-sample R2 says nothing. A
mapping is "fixed" only if weights fitted on five blocks predict the sixth. Two
scores per candidate:

  absolute  - the held-out block's points predicted outright (what "session X ate
              N points" needs if the page has no meter delta to divide)
  share     - the held-out block's own total rescaled onto the intervals (what
              the page needs if it only has to split a delta it already knows)
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


def candidates(rows):
    c = [
        ("total tokens", ["tok"], 1e6),
        ("list-price cost", ["cost"], 1.0),
        ("cost per family", [f"cost_{f}" for f in FAMS], 1.0),
        ("requests", ["reqs"], 100.0),
        ("requests per family", [f"req_{f}" for f in FAMS], 100.0),
        ("output tokens", ["any_out"], 1e6),
        ("output per family", [f"{f}_out" for f in FAMS], 1e6),
        ("out + cache-write per family", [f"{f}_{k}" for f in FAMS for k in ("out", "cw1h", "cw5m")], 1e6),
        ("tokens per kind", [f"any_{k}" for k in KINDS], 1e6),
        ("tokens per family per kind", [f"{f}_{k}" for f in FAMS for k in KINDS], 1e6),
        ("cost + requests per family", [f"cost_{f}" for f in FAMS] + [f"req_{f}" for f in FAMS], 1.0),
    ]
    return c


def main():
    rows = F.dataset(BIN)
    bl = B.blocks()
    lo = min(x["t"] for rs in bl.values() for x in rs)
    hi = max(x["t"] for rs in bl.values() for x in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    alts.enrich(rows, recs)
    blocks_ = sorted({r["block"] for r in rows})
    ybar = sum(r["dy"] for r in rows) / len(rows)
    ss_tot = sum((r["dy"] - ybar) ** 2 for r in rows)

    print(f"bin >= {BIN}s, {len(rows)} intervals, {len(blocks_)} blocks, "
          f"mean |dy| {sum(abs(r['dy']) for r in rows)/len(rows):.2f} pts\n")
    print(f"{'features':32} {'k':>2} {'absR2':>7} {'absRMSE':>8} {'blockerr%':>10} "
          f"{'shareR2':>8} {'shareRMSE':>10}")
    out = {}
    for name, feats, sc in candidates(rows):
        ss_abs = ss_share = 0.0
        blockerr = []
        for held in blocks_:
            tr = [r for r in rows if r["block"] != held]
            te = [r for r in rows if r["block"] == held]
            X = [[r[f] / sc for f in feats] for r in tr]
            w = linalg.nnls(X, [r["dy"] for r in tr])
            pr = [sum(r[f] / sc * w[i] for i, f in enumerate(feats)) for r in te]
            ya = [r["dy"] for r in te]
            ss_abs += sum((a - b) ** 2 for a, b in zip(ya, pr))
            tot_p, tot_y = sum(pr), sum(ya)
            blockerr.append((tot_p - tot_y) / tot_y * 100 if tot_y else 0.0)
            k = tot_y / tot_p if tot_p else 0.0
            ss_share += sum((a - b * k) ** 2 for a, b in zip(ya, pr))
        n = len(rows)
        out[name] = (1 - ss_abs / ss_tot, (ss_abs / n) ** 0.5,
                     1 - ss_share / ss_tot, (ss_share / n) ** 0.5, blockerr)
        r2a, rma, r2s, rms, be = out[name]
        worst = max(abs(x) for x in be)
        print(f"{name:32} {len(feats):2d} {r2a:7.3f} {rma:8.2f} {worst:9.0f}% {r2s:8.3f} {rms:10.2f}")

    print("\nper-block error of the held-out absolute prediction (%, + = over)")
    print(f"{'features':32} " + " ".join(f"{datetime.fromtimestamp(b-5*3600):>8%d %H:%M}" for b in blocks_))
    for name in out:
        be = out[name][4]
        print(f"{name:32} " + " ".join(f"{e:+8.0f}" for e in be))


if __name__ == "__main__":
    main()
