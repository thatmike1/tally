#!/usr/bin/env python3
"""does a fixed linear map exist from tokens to points of the 5h meter?

Builds one row per time interval inside a clean block: the meter delta over the
interval, and the tokens spent in it by model family and token kind. Then fits
several candidate mappings and prints the residuals.

  python3 fit.py [bin_seconds]      default 900
"""
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B
import extract
import linalg

KINDS = B.KINDS
FAMS = ("opus", "fable", "sonnet", "haiku")
BIN = int(sys.argv[1]) if len(sys.argv) > 1 else 900


def dataset(bin_seconds=BIN):
    bl = B.blocks()
    lo = min(r["t"] for rs in bl.values() for r in rs)
    hi = max(r["t"] for rs in bl.values() for r in rs)
    recs = extract.records(lo - 6 * 3600, hi + 3600)
    rows = []
    for reset, raw in bl.items():
        m = B.monotonic(raw)
        if len(m) < 4 or m[-1]["pct"] - m[0]["pct"] < 3:
            continue
        # coarsen: walk the samples, close an interval once it is long enough
        edges = [m[0]]
        for s in m[1:]:
            if s["t"] - edges[-1]["t"] >= bin_seconds:
                edges.append(s)
        if edges[-1] is not m[-1]:
            edges.append(m[-1])
        for a, b in zip(edges, edges[1:]):
            # the meter saturates at 100, so an interval that ends there has a
            # censored target and cannot constrain a weight
            if b["pct"] >= 100:
                continue
            inb = [r for r in recs if a["t"] <= r["t"] < b["t"]]
            row = {
                "block": reset,
                "t0": a["t"], "t1": b["t"],
                "dy": b["pct"] - a["pct"],
                "cost": sum(r["cost"] for r in inb),
                "tok": sum(r[k] for r in inb for k in KINDS),
                "n": len(inb),
            }
            for f in FAMS:
                sel = [r for r in inb if r["fam"] == f]
                row[f"cost_{f}"] = sum(r["cost"] for r in sel)
                for k in KINDS:
                    row[f"{f}_{k}"] = sum(r[k] for r in sel)
            rows.append(row)
    return rows


def run(name, rows, feats, scale, nonneg=True):
    X = [[r[f] / scale for f in feats] for r in rows]
    y = [r["dy"] for r in rows]
    w = linalg.nnls(X, y) if nonneg else linalg.lstsq(X, y, ridge=1e-9)
    st = linalg.stats(X, y, w)
    print(f"\n{name}")
    print("  weights (points per unit, unit = {}):".format(scale))
    for f, v in zip(feats, w):
        print(f"    {f:16s} {v:12.5f}")
    print(f"  R2={st['r2']:.3f}  RMSE={st['rmse']:.2f} pts  MAE={st['mae']:.2f} pts  "
          f"(mean |dy| = {sum(abs(r['dy']) for r in rows)/len(rows):.2f})")
    return w, st


def main():
    rows = dataset()
    print(f"{len(rows)} intervals, bin >= {BIN}s, "
          f"{len({r['block'] for r in rows})} blocks")
    print(f"total meter movement covered: {sum(r['dy'] for r in rows):.0f} pts, "
          f"{sum(r['tok'] for r in rows)/1e6:.1f} Mtok, ${sum(r['cost'] for r in rows):.0f}")

    # intervals where the meter moved but nothing ran locally
    ghost = [r for r in rows if r["dy"] >= 1 and r["n"] == 0]
    quiet = [r for r in rows if r["dy"] == 0 and r["tok"] > 1e6]
    print(f"\nmeter moved with zero local requests: {len(ghost)} intervals, "
          f"{sum(r['dy'] for r in ghost):.0f} pts "
          f"({sum(r['dy'] for r in ghost)/max(1,sum(r['dy'] for r in rows))*100:.0f}% of all movement)")
    for r in ghost:
        print(f"    {datetime.fromtimestamp(r['t0']):%d %b %H:%M}-"
              f"{datetime.fromtimestamp(r['t1']):%H:%M}  +{r['dy']:.0f} pts, 0 requests")
    print(f"local tokens with a flat meter: {len(quiet)} intervals, "
          f"{sum(r['tok'] for r in quiet)/1e6:.1f} Mtok, ${sum(r['cost'] for r in quiet):.0f}")

    run("A. raw total tokens", rows, ["tok"], 1e6)
    run("B. list-price cost", rows, ["cost"], 1.0)
    run("C. cost per model family", rows, [f"cost_{f}" for f in FAMS], 1.0)
    feats = [f"{f}_{k}" for f in FAMS for k in KINDS]
    run("D. tokens per family per kind", rows, feats, 1e6)
    # family-blind per-kind needs the aggregate columns
    for r in rows:
        for k in KINDS:
            r[f"any_{k}"] = sum(r[f"{f}_{k}"] for f in FAMS)
    run("E. tokens per kind, family-blind", rows, [f"any_{k}" for k in KINDS], 1e6)

    print("\nper-block calibration: points actually moved vs each model's prediction")
    hdr = f"{'block':13} {'pts':>5} {'A tok':>7} {'B cost':>7} {'C fam$':>7} {'D f×k':>7}"
    print(hdr)
    fits = {
        "A": (["tok"], 1e6), "B": (["cost"], 1.0),
        "C": ([f"cost_{f}" for f in FAMS], 1.0),
        "D": (feats, 1e6),
    }
    ws = {}
    for key, (fs, sc) in fits.items():
        X = [[r[f] / sc for f in fs] for r in rows]
        ws[key] = (linalg.nnls(X, [r["dy"] for r in rows]), fs, sc)
    for reset in sorted({r["block"] for r in rows}):
        sub = [r for r in rows if r["block"] == reset]
        line = f"{datetime.fromtimestamp(reset-5*3600):%d %b %H:%M} {sum(r['dy'] for r in sub):5.0f}"
        for key in "ABCD":
            w, fs, sc = ws[key]
            p = sum(sum(r[f] / sc * w[i] for i, f in enumerate(fs)) for r in sub)
            line += f" {p:7.1f}"
        print(line)

    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "intervals.json"), "w") as fh:
        json.dump(rows, fh)


if __name__ == "__main__":
    main()
