#!/usr/bin/env bash
# regenerate the expected tables from the python oracle.
#
# the proof's scripts in `scripts/oracle/` are the authority for these numbers, so
# the fixtures they produce are checked in and the vitest suite compares against
# them. they price from `test/fixtures/models.json`, the same frozen facts the
# tests use. run this only when the fixture home or that file changes
# (scripts/make-fixtures.py).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
oracle="$here/scripts/oracle"
home="$here/test/fixtures/home"
export TALLY_MODELS="$here/test/fixtures/models.json"

HOME="$home" python3 "$oracle/extract.py" 0 9999999999 > "$here/test/fixtures/requests-expected.jsonl"
HOME="$home" python3 "$oracle/survey.py" > "$here/test/fixtures/survey-expected.txt"

echo "wrote:"
wc -l "$here/test/fixtures/requests-expected.jsonl"
head -3 "$here/test/fixtures/survey-expected.txt"
