#!/usr/bin/env python3
"""per-request token records from every local transcript, for a time window.

Parsing rule is burn.py's, unchanged: one API request is several JSONL lines
sharing a message id, the cache figures repeat and output_tokens grows, so the
last line for a message id is the true total. Here the record is kept per
request rather than summed per session, because the fit needs the timestamp.

Usage: extract.py <start_unix> <end_unix> > requests.jsonl
"""
import glob
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

# list prices come from the model map's models.json, the file tally itself reads:
# $TALLY_MODELS, else the ccChat-general checkout, else the published copy
MODELS_PATHS = [os.environ.get("TALLY_MODELS"),
                os.path.expanduser("~/git/ccChat-general/claude/model-map/models.json")]
MODELS_URL = os.environ.get("TALLY_MODELS_URL") or "https://models.thatmike1.dev/models.json"
# a date or version tag may follow a known id; any other suffix is another model
SUFFIX = re.compile(r"^[-@](\d{6,8}|\d{4}-\d{2}(-\d{2})?|v\d+(:\d+)?|latest)$")


def load_facts():
    for path in MODELS_PATHS:
        if path and os.path.exists(path):
            with open(path) as f:
                return json.load(f)
    with urllib.request.urlopen(MODELS_URL, timeout=15) as r:
        return json.loads(r.read())


FACTS = load_facts()


def resolve(model):
    key = re.sub(r"\[[^\]]*\]$", "", model.strip().lower())
    if key in FACTS["models"]:
        return key
    if key in FACTS["aliases"]:
        return FACTS["aliases"][key]
    best = None
    for mid in FACTS["models"]:
        if key.startswith(mid) and SUFFIX.match(key[len(mid):]) and (best is None or len(mid) > len(best)):
            best = mid
    return best


def prices(model):
    """the anthropic price row, usd per 1M tokens, or None"""
    mid = resolve(model)
    m = FACTS["models"][mid] if mid else None
    return m["prices"] if m and m["vendor"] == "Anthropic" and m["prices"] else None


def price(model):
    p = prices(model)
    return (p["input"], p["output"]) if p else None


def request_cost(model, tin, w1h, w5m, cr, out):
    p = prices(model)
    if not p:
        return 0.0
    prompt = tin + w1h + w5m + cr
    tiers = sorted((t for t in p["tiers"] if prompt > t["aboveInputTokens"]),
                   key=lambda t: -t["aboveInputTokens"])
    if tiers:
        p = {**p, **tiers[0]}
    i = p["input"]
    return (tin * i + w1h * p.get("cacheWrite1h", i * 2) + w5m * p.get("cacheWrite5m", i * 1.25)
            + cr * p.get("cacheRead", i * 0.1) + out * p["output"]) / 1e6


def family(model):
    for name in ("fable", "mythos", "opus", "sonnet", "haiku"):
        if name in model:
            return name
    return "other"


def effort(r):
    """the line's effort level, its perTurnEffort when only that is there, else None."""
    for key in ("effort", "perTurnEffort"):
        v = r.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def files():
    home = os.path.expanduser("~/.claude/projects")
    return (glob.glob(f"{home}/*/*.jsonl")
            + glob.glob(f"{home}/*/*/subagents/*.jsonl"))


def records(start, end):
    """last line per (file, message id), inside the window."""
    last = {}
    for f in files():
        sub = "/subagents/" in f
        if sub:
            sid = os.path.basename(f)[:-6][:26]
            proj = os.path.basename(os.path.dirname(os.path.dirname(f)))
        else:
            sid = os.path.basename(f)[:-6]
            proj = os.path.basename(os.path.dirname(f))
        try:
            st = os.stat(f)
        except OSError:
            continue
        if st.st_mtime < start:
            continue
        for line in open(f, errors="replace"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("type") != "assistant":
                continue
            ts = r.get("timestamp")
            if not ts:
                continue
            t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            if not (start <= t < end):
                continue
            m = r.get("message", {})
            mid = m.get("id")
            u = m.get("usage") or {}
            if not u or not mid:
                continue
            model = m.get("model", "?")
            cw = u.get("cache_creation") or {}
            w1h = int(cw.get("ephemeral_1h_input_tokens") or 0)
            w5m = int(cw.get("ephemeral_5m_input_tokens") or 0)
            if not cw:
                w5m = int(u.get("cache_creation_input_tokens") or 0)
            rec = {
                "t": t,
                "file": f,
                "mid": mid,
                "req": r.get("requestId"),
                "proj": proj,
                "sid": sid,
                "agent": bool(r.get("isSidechain")) or sub,
                "model": model,
                "fam": family(model),
                "in": int(u.get("input_tokens") or 0),
                "cw1h": w1h,
                "cw5m": w5m,
                "cr": int(u.get("cache_read_input_tokens") or 0),
                "out": int(u.get("output_tokens") or 0),
                "priced": model == "<synthetic>" or price(model) is not None,
                "effort": effort(r),
            }
            rec["cost"] = request_cost(model, rec["in"], w1h, w5m, rec["cr"], rec["out"])
            last[(f, mid)] = rec
    return sorted(last.values(), key=lambda r: r["t"])


if __name__ == "__main__":
    s, e = float(sys.argv[1]), float(sys.argv[2])
    for r in records(s, e):
        print(json.dumps(r))
