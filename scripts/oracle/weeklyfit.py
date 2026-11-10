#!/usr/bin/env python3
"""fit per-family weights on the weekly meter, then test them on the 5h blocks.

The weekly series is the better-conditioned problem: one window, no block edges,
295 samples, a smooth monotone climb. Whatever weights explain it should explain
the 5h meter too if both count the same thing.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blocks as B
import extract
import linalg

FAMS = ("opus", "fable", "sonnet", "haiku")
KINDS = B.KINDS


def series():
    s = [r for r in B.samples() if r["wk"] is not None]
    lo, hi = s[0]["t"], s[-1]["t"]
    recs = extract.records(lo - 24 * 3600, hi + 60)
    return s, [r for r in recs if r["t"] >= lo], lo


def cum_features(s, recs, lo, feats_of):
    """cumulative feature vector at each sample time."""
    recs = sorted(recs, key=lambda r: r["t"])
    out, i, acc = [], 0, None
    for r in s:
        while i < len(recs) and recs[i]["t"] < r["t"]:
            v = feats_of(recs[i])
            acc = v if acc is None else [a + b for a, b in zip(acc, v)]
            i += 1
        out.append(list(acc) if acc else [0.0] * len(feats_of(recs[0])))
    return out


def fit(name, s, recs, lo, feats_of, target, base):
    X = cum_features(s, recs, lo, feats_of)
    y = [t(r) - base for r in s]
    w = linalg.nnls(X, y)
    st = linalg.stats(X, y, w) if False else linalg.stats(X, y, w)
    return w, st, X, y


def main():
    s, recs, lo = series()
    print(f"weekly window: {len(s)} samples, "
          f"{datetime.fromtimestamp(lo):%d %b %H:%M} -> {datetime.fromtimestamp(s[-1]['t']):%d %b %H:%M}")

    def cost_by_fam(r):
        return [r["cost"] if r["fam"] == f else 0.0 for f in FAMS]

    def tok_by_fam(r):
        return [sum(r[k] for k in KINDS) / 1e6 if r["fam"] == f else 0.0 for f in FAMS]

    def outcr_by_fam(r):
        v = []
        for f in FAMS:
            on = r["fam"] == f
            v += [(r["out"] if on else 0) / 1e6,
                  ((r["cw1h"] + r["cw5m"]) if on else 0) / 1e6,
                  ((r["cr"] + r["in"]) if on else 0) / 1e6]
        return v

    for name, fn, labels in [
        ("cost per family", cost_by_fam, FAMS),
        ("tokens per family", tok_by_fam, FAMS),
        ("out / cache-write / read per family", outcr_by_fam,
         [f"{f}.{k}" for f in FAMS for k in ("out", "cwrite", "read")]),
    ]:
        X = cum_features(s, recs, lo, fn)
        y = [r["wk"] - s[0]["wk"] for r in s]
        w = linalg.nnls(X, y)
        st = linalg.stats(X, y, w)
        print(f"\n7-day meter <- {name}")
        for lb, v in zip(labels, w):
            print(f"    {lb:20s} {v:10.4f} pts/unit")
        print(f"    R2={st['r2']:.4f} RMSE={st['rmse']:.2f} pts (range {min(y):.0f}..{max(y):.0f})")

    # the Fable weekly meter against Fable work only
    fab = [r for r in recs if r["fam"] == "fable"]
    X = cum_features(s, fab, lo, lambda r: [r["cost"], sum(r[k] for k in KINDS) / 1e6, r["out"] / 1e6])
    y = [r["scoped"].get("Fable", 0) - s[0]["scoped"].get("Fable", 0) for r in s]
    for lbl, cols in [("cost", [0]), ("tokens", [1]), ("output tokens", [2]),
                      ("cost + output", [0, 2])]:
        Xi = [[row[c] for c in cols] for row in X]
        w = linalg.nnls(Xi, y)
        st = linalg.stats(Xi, y, w)
        print(f"Fable weekly meter <- {lbl:15s} w={[round(v,4) for v in w]} "
              f"R2={st['r2']:.4f} RMSE={st['rmse']:.2f} pts (0..{max(y):.0f})")

    # now carry the weekly per-family cost weights onto the 5h blocks
    X = cum_features(s, recs, lo, cost_by_fam)
    w = linalg.nnls(X, [r["wk"] - s[0]["wk"] for r in s])
    ratio = [v / w[0] for v in w]
    print(f"\nrelative burn per list-price dollar (opus = 1): "
          + ", ".join(f"{f}={r:.2f}" for f, r in zip(FAMS, ratio)))
    bl = B.blocks()
    allrecs = extract.records(min(x['t'] for rs in bl.values() for x in rs) - 6 * 3600,
                              max(x['t'] for rs in bl.values() for x in rs) + 3600)
    print(f"\n5h blocks scored with the weekly weights")
    print(f"{'block':13} {'pts':>5} {'weighted$':>10} {'pts/w$':>7} {'plain$':>7} {'pts/$':>6}")
    for reset, raw in bl.items():
        m = B.monotonic(raw)
        if len(m) < 4:
            continue
        inb = [x for x in allrecs if m[0]["t"] <= x["t"] < m[-1]["t"]]
        pts = m[-1]["pct"] - m[0]["pct"]
        wc = sum(x["cost"] * ratio[FAMS.index(x["fam"])] for x in inb if x["fam"] in FAMS)
        c = sum(x["cost"] for x in inb)
        print(f"{datetime.fromtimestamp(reset-5*3600):%d %b %H:%M} {pts:5.0f} {wc:10.1f} "
              f"{pts/wc if wc else 0:7.3f} {c:7.1f} {pts/c if c else 0:6.3f}")


if __name__ == "__main__":
    main()
