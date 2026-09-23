#!/usr/bin/env python3
"""build the test fixture home out of a few real transcripts, stripped.

only the fields both parsers read survive: no message content ever lands in the
repo. the first user line of each file keeps a placeholder so the title parser
has something to find.

  python3 scripts/make-fixtures.py

then `bash scripts/refresh-oracle.sh` regenerates the expected tables from the
python oracle over exactly these files.
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(HERE, "test", "fixtures", "home")
REAL = os.path.expanduser("~/.claude/projects")
PROJECT = "-home-thatmike1-git-ccChat-general"
SESSIONS = [
    "e286acd1-7e04-4cc3-ba02-3975985f7a95",
    "6540615c-78fa-4cce-ad83-291217cfc6ae",
    "481ee5b2-ae1b-4816-a072-8c9610b80c5a",
]


def strip(src, dst, label):
    seen_user = False
    kept = 0
    with open(src, errors="replace") as fh, open(dst, "w") as out:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("type") == "assistant":
                m = r.get("message") or {}
                u = m.get("usage")
                if not u or not m.get("id"):
                    continue
                usage = {k: u[k] for k in
                         ("input_tokens", "cache_creation_input_tokens",
                          "cache_read_input_tokens", "output_tokens") if k in u}
                if "cache_creation" in u:
                    usage["cache_creation"] = u["cache_creation"]
                row = {
                    "type": "assistant",
                    "timestamp": r.get("timestamp"),
                    "requestId": r.get("requestId"),
                    "isSidechain": bool(r.get("isSidechain")),
                    "message": {"id": m["id"], "model": m.get("model", "?"), "usage": usage},
                }
                # the effort level both parsers read, when the line records one
                for k in ("effort", "perTurnEffort"):
                    if k in r:
                        row[k] = r[k]
                out.write(json.dumps(row) + "\n")
                kept += 1
            elif r.get("type") == "user" and not seen_user:
                seen_user = True
                out.write(json.dumps({
                    "type": "user",
                    "timestamp": r.get("timestamp"),
                    "isSidechain": bool(r.get("isSidechain")),
                    "message": {"role": "user", "content": f"fixture session {label}"},
                }) + "\n")
    return kept


def main():
    root = os.path.join(FIXTURE, ".claude", "projects", PROJECT)
    if os.path.isdir(FIXTURE):
        shutil.rmtree(os.path.join(FIXTURE, ".claude"), ignore_errors=True)
    os.makedirs(root, exist_ok=True)
    total = 0
    for sid in SESSIONS:
        src = os.path.join(REAL, PROJECT, f"{sid}.jsonl")
        if not os.path.exists(src):
            print(f"missing {src}", file=sys.stderr)
            continue
        total += strip(src, os.path.join(root, f"{sid}.jsonl"), sid[:8])
        agents = os.path.join(REAL, PROJECT, sid, "subagents")
        if not os.path.isdir(agents):
            continue
        dst_agents = os.path.join(root, sid, "subagents")
        os.makedirs(dst_agents, exist_ok=True)
        for name in sorted(os.listdir(agents)):
            if name.endswith(".jsonl"):
                total += strip(os.path.join(agents, name), os.path.join(dst_agents, name), name[:-6])

    cache = os.path.join(FIXTURE, ".cache", "cc-browse-tray")
    os.makedirs(cache, exist_ok=True)
    shutil.copy(os.path.expanduser("~/.cache/cc-browse-tray/limits.jsonl"),
                os.path.join(cache, "limits.jsonl"))
    print(f"{total} assistant lines kept in {FIXTURE}")


if __name__ == "__main__":
    main()
