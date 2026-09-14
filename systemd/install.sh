#!/usr/bin/env bash
# build the ui and run tally and its tray icon as systemd user services.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

npm run build
chmod +x "$HERE/../tray/tally-tray.py"

# enable by absolute path links the unit out of this repo, so edits here apply
# after a daemon-reload with no copy step
systemctl --user enable --now "$HERE/tally.service"
systemctl --user enable --now "$HERE/tally-tray.service"

echo
systemctl --user --no-pager status tally.service tally-tray.service | head -16
echo
echo "page:      http://127.0.0.1:1337"
echo "uninstall: systemctl --user disable --now tally.service tally-tray.service"
