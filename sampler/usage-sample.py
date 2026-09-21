#!/usr/bin/python3
"""append one account-meter reading to tally's limits log, from the /usage endpoint.

tally reads ~/.cache/tally/limits.jsonl and trusts only the `src: "api"` rows,
which this script is the sole writer of. The alternative source, whatever a
Claude Code statusline last printed, has holes exactly where they hurt:
overnight, background agents, anything run with every tab closed. Asking the
account directly costs no tokens, needs no session running, and runs off
tally-sampler.timer every five minutes.

Rows keep the shape a statusline hook writes, so one reader takes both without
knowing the difference; the fields the endpoint adds sit alongside.
"""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime

CREDS = os.path.expanduser("~/.claude/.credentials.json")
# every write below makedirs this first, so a fresh machine needs no setup step
CACHE = os.path.expanduser("~/.cache/tally")
LOG = os.path.join(CACHE, "limits.jsonl")
# the whole response, every sample: the endpoint grows fields (the per-surface
# seven_day_breakdown appeared by Sep 2026) that the trimmed rows above never
# carry, and a field nobody logged cannot be backfilled. kept apart so readers
# of LOG do not parse ~2.5 KB a row
RAW_LOG = os.path.join(CACHE, "usage-raw.jsonl")
URL = "https://api.anthropic.com/api/oauth/usage"

# a rejected token stays rejected until claude refreshes it, which rewrites the
# credentials file. remembering which file we were rejected on stops the timer
# from firing the same 401 every 5 minutes for as long as claude is not running.
BLOCK = os.path.join(CACHE, "usage-sample-401")

# the endpoint answers 429 when two machines ask on the same account. each 429
# doubles the wait before the next try (10, 20, 40, 80 min), a success clears it.
BACKOFF = os.path.join(CACHE, "usage-sample-429")
BACKOFF_FIRST = 600
BACKOFF_MAX = 4800

# `USAGE_UPSTREAM=user@host` makes that machine the sampler: this one copies the
# new lines of its two logs over ssh and only asks the endpoint itself when the
# upstream's newest sample is older than UPSTREAM_FRESH, so one caller is the
# normal case and a dead upstream still leaves no hole.
UPSTREAM = os.environ.get("USAGE_UPSTREAM")
UPSTREAM_FRESH = 12 * 60

# `USAGE_REFRESH=1` is for a machine where claude sits idle (the VPS): the access
# token lasts 8 h and only a claude that talks to the api renews it, `claude auth
# status` does not. on a 401 one haiku turn goes out so claude itself rewrites the
# credentials file, under its own lock, and the sample is retried once.
REFRESH = os.environ.get("USAGE_REFRESH") == "1"
REFRESH_CMD = [
    "claude", "-p", "reply with the single word ok",
    "--model", "haiku", "--no-session-persistence", "--tools", "",
]


def last_api_t(path):
    """the time of the newest endpoint sample in a log, 0 when there is none"""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 400_000))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return 0
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if is_api_row(row):
            return row["t"]
    return 0


def is_api_row(row) -> bool:
    """an endpoint sample: `src: api` in the limits log, a `payload` in the raw one. statusline.sh rows carry neither"""
    return (
        isinstance(row, dict)
        and (row.get("src") == "api" or "payload" in row)
        and isinstance(row.get("t"), (int, float))
    )


def pull_upstream() -> bool:
    """append the upstream's new samples to both logs. true when its newest one is fresh enough to stand in for ours"""
    # the upstream's own newest sample, never ours: measured on the local log, a
    # row we sampled ourselves (or, before is_api_row, any statusline row) made a
    # dead upstream look alive
    newest = 0
    for path in (LOG, RAW_LOG):
        have = last_api_t(path)
        want = min(3000, int((time.time() - have) / 300) + 5) if have else 3000
        # an upstream still on the pre-tally sampler writes the old cache dir, so
        # ask for both and let the shell pick; a file missing on both sides exits
        # non-zero and we fall through to sampling ourselves
        name = os.path.basename(path)
        cmd = f"tail -n {want} ~/.cache/tally/{name} 2>/dev/null || tail -n {want} ~/.cache/cc-browse-tray/{name}"
        try:
            out = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", UPSTREAM, cmd],
                capture_output=True, text=True, timeout=40, check=True,
            ).stdout
        except (subprocess.SubprocessError, OSError):
            return False
        fresh = []
        for line in out.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not is_api_row(row):
                continue
            newest = max(newest, row["t"])
            if row["t"] > have:
                fresh.append(line)
        if fresh:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a") as f:
                f.write("\n".join(fresh) + "\n")
    return time.time() - newest < UPSTREAM_FRESH


def backing_off() -> bool:
    try:
        with open(BACKOFF) as f:
            return time.time() < json.load(f)["until"]
    except (OSError, ValueError, KeyError):
        return False


def note_429():
    try:
        with open(BACKOFF) as f:
            wait = min(BACKOFF_MAX, json.load(f)["wait"] * 2)
    except (OSError, ValueError, KeyError):
        wait = BACKOFF_FIRST
    os.makedirs(os.path.dirname(BACKOFF), exist_ok=True)
    with open(BACKOFF, "w") as f:
        json.dump({"wait": wait, "until": time.time() + wait}, f)


def fetch(tok):
    req = urllib.request.Request(
        URL,
        headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def token():
    with open(CREDS) as f:
        return (json.load(f).get("claudeAiOauth") or {}).get("accessToken")


def refreshed(stamp) -> bool:
    """have claude renew the token. true when the credentials file changed"""
    try:
        subprocess.run(REFRESH_CMD, capture_output=True, timeout=120, cwd="/tmp")
    except (subprocess.SubprocessError, OSError):
        return False
    return str(os.path.getmtime(CREDS)) != stamp


def ts(value):
    return int(datetime.fromisoformat(value).timestamp()) if value else None


def main() -> int:
    if UPSTREAM and pull_upstream():
        return 0
    if backing_off():
        return 0
    tok = token()
    if not tok:
        return 1
    stamp = str(os.path.getmtime(CREDS))
    if os.path.exists(BLOCK) and open(BLOCK).read() == stamp:
        return 0

    try:
        try:
            u = fetch(tok)
        except urllib.error.HTTPError as e:
            if e.code != 401 or not REFRESH or not refreshed(stamp):
                raise
            stamp = str(os.path.getmtime(CREDS))
            u = fetch(token())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            os.makedirs(os.path.dirname(BLOCK), exist_ok=True)
            with open(BLOCK, "w") as f:
                f.write(stamp)
        if e.code == 429:
            note_429()
            return 0
        raise
    if os.path.exists(BACKOFF):
        os.remove(BACKOFF)

    now = int(time.time())
    os.makedirs(os.path.dirname(RAW_LOG), exist_ok=True)
    with open(RAW_LOG, "a") as f:
        f.write(json.dumps({"t": now, "payload": u}, separators=(",", ":")) + "\n")

    row = {"t": now, "src": "api", "limits": {}}
    for key in ("five_hour", "seven_day"):
        d = u.get(key) or {}
        if d.get("utilization") is None:
            continue
        row["limits"][key] = {
            # statusline.sh logs a whole number here and limits.py formats the
            # field with `%d`; the endpoint reports the same value as a float
            "used_percentage": int(d["utilization"]),
            "resets_at": ts(d.get("resets_at")),
        }
    if not row["limits"]:
        return 1

    # the weekly meter is also reported per model, which nothing else on this box
    # can see: it is the only answer to "how much of the week did Fable eat"
    scoped = [
        {
            "model": ((l.get("scope") or {}).get("model") or {}).get("display_name"),
            "percent": l.get("percent"),
            "resets_at": ts(l.get("resets_at")),
        }
        for l in (u.get("limits") or [])
        if l.get("kind") == "weekly_scoped"
    ]
    if scoped:
        row["scoped"] = scoped

    # the paid overflow, in real money
    extra = u.get("extra_usage") or {}
    if extra.get("is_enabled"):
        row["extra"] = {
            "used": extra.get("used_credits"),
            "limit": extra.get("monthly_limit"),
            "currency": extra.get("currency"),
        }

    # all limit entries other than weekly_scoped (e.g. session, weekly_all, or boosts)
    other_limits = [
        l for l in (u.get("limits") or [])
        if l.get("kind") != "weekly_scoped"
    ]
    if other_limits:
        row["other_limits"] = other_limits

    # all top-level keys other than the ones modelled above
    raw_extra = {
        k: v
        for k, v in u.items()
        if k not in ("five_hour", "seven_day", "limits", "extra_usage")
    }
    if raw_extra:
        row["raw_extra"] = raw_extra

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    # every sample is written, unchanged or not: a flat stretch and an unobserved
    # one look identical in a deduped log, and telling them apart is the point
    with open(LOG, "a") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
