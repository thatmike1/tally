#!/usr/bin/env bash
# build the ui and run tally as a systemd user service on 127.0.0.1:1337.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

npm run build
# enable by absolute path links the unit out of this repo, so edits here apply
# after a daemon-reload with no copy step
systemctl --user enable --now "$HERE/tally.service"

echo
systemctl --user --no-pager status tally.service | head -8
echo
echo "page:      http://127.0.0.1:1337"
echo "uninstall: systemctl --user disable --now tally.service"
