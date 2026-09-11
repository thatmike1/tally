#!/usr/bin/env bash
# regenerate the expected tables from the python oracle.
#
# the proof's `jobs/*.py` are the authority for these numbers, so the fixtures
# they produce are checked in and the vitest suite compares against them. run
# this only when the fixture home changes (scripts/make-fixtures.py).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
jobs="${TALLY_JOBS:-$HOME/git/ccChat-general/projects/tally/jobs}"
home="$here/test/fixtures/home"

if [ ! -d "$jobs" ]; then
  echo "oracle scripts not found at $jobs (set TALLY_JOBS)" >&2
  exit 2
fi

HOME="$home" python3 "$jobs/extract.py" 0 9999999999 > "$here/test/fixtures/requests-expected.jsonl"
HOME="$home" python3 "$jobs/survey.py" > "$here/test/fixtures/survey-expected.txt"

echo "wrote:"
wc -l "$here/test/fixtures/requests-expected.jsonl"
head -3 "$here/test/fixtures/survey-expected.txt"
