#!/bin/bash
# did any Claude Code run somewhere other than this laptop during the sampled
# span? the Hetzner box hosts claude-rc, so it is the one other machine on the
# same account that leaves a transcript we can read.
set -e
sed 's|~/.claude/projects|/root/.claude/projects|' "$(dirname "$0")/extract.py" \
  | ssh root@46.224.84.191 'cat > /tmp/extract_vps.py && python3 /tmp/extract_vps.py '"${1:-1788870000} ${2:-1789080000}"
