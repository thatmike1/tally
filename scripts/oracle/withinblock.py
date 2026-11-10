#!/usr/bin/env python3
"""the question the page actually asks: inside one block, does share of tokens
(or cost) predict share of the points the meter moved?

The page never needs an absolute points-per-token constant. It knows the block's
meter delta from the samples; it only has to divide it. So the test is whether
the shape is stable within a block once the block total is normalised away.

  python3 withinblock.py [bin_seconds]
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit as F
import linalg

BINS = [int(a) for a in sys.argv[1:]] or [900, 1800, 3600]
FAMS = F.FAMS


def norm_eval(rows, feats, scale, w):
    """predict, then rescale each block so its total matches the meter delta."""
    out = []
    for reset in sorted({r["block"] for r in rows}):
        sub = [r for r in rows if r["block"] == reset]
        raw = [sum(r[f] / scale * w[i] for i, f in enumerate(feats)) for r in sub]
        tot_raw, tot_y = sum(raw), sum(r["dy"] for r in sub)
        k = tot_y / tot_raw if tot_raw else 0.0
        for r, p in zip(sub, raw):
            out.append((r, p * k, k))
    y = [r["dy"] for r, _, _ in out]
    pred = [p for _, p, _ in out]
    ybar = sum(y) / len(y)
    ss_res = sum((a - b) ** 2 for a, b in zip(y, pred))
    ss_tot = sum((v - ybar) ** 2 for v in y) or 1e-12
    return {
        "r2": 1 - ss_res / ss_tot,
        "rmse": (ss_res / len(y)) ** 0.5,
        "mae": sum(abs(a - b) for a, b in zip(y, pred)) / len(y),
        "scales": {reset: k for r, _, k in out for reset in [r["block"]]},
        "rows": out,
    }


def main():
    for bs in BINS:
        rows = F.dataset(bs)
        rows = [r for r in rows if r["dy"] is not None]
        print(f"\n===== bin >= {bs}s : {len(rows)} intervals, "
              f"{sum(r['dy'] for r in rows):.0f} pts, "
              f"mean |dy| {sum(abs(r['dy']) for r in rows)/len(rows):.2f} =====")
        cands = [
            ("total tokens", ["tok"], 1e6),
            ("list-price cost", ["cost"], 1.0),
            ("cost per family", [f"cost_{f}" for f in FAMS], 1.0),
            ("tokens per family per kind", [f"{f}_{k}" for f in FAMS for k in F.KINDS], 1e6),
        ]
        for r in rows:
            for k in F.KINDS:
                r[f"any_{k}"] = sum(r[f"{f}_{k}"] for f in FAMS)
        cands.append(("tokens per kind", [f"any_{k}" for k in F.KINDS], 1e6))
        for name, feats, sc in cands:
            X = [[r[f] / sc for f in feats] for r in rows]
            w = linalg.nnls(X, [r["dy"] for r in rows])
            glob = linalg.stats(X, [r["dy"] for r in rows], w)
            nb = norm_eval(rows, feats, sc, w)
            print(f"  {name:28s} global R2={glob['r2']:.3f} RMSE={glob['rmse']:.2f} | "
                  f"block-normalised R2={nb['r2']:.3f} RMSE={nb['rmse']:.2f} MAE={nb['mae']:.2f}")
            if name == "list-price cost":
                ks = nb["scales"]
                print("      per-block rescale factor needed: "
                      + ", ".join(f"{datetime.fromtimestamp(b-5*3600):%d %H:%M}={k:.2f}"
                                  for b, k in sorted(ks.items())))


if __name__ == "__main__":
    main()
