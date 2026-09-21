#!/usr/bin/env bash
# stop tally and remove the units install.sh rendered.
#
# the meter log in ~/.cache/tally and ~/.config/tally/config.json stay: the log
# is the history the page exists to show, and the config is the user's. so does
# any tally-sampler.service.d drop-in, which is config too.
set -euo pipefail

UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now tally.service tally-tray.service tally-sampler.timer 2>/dev/null || true
rm -f "$UNITS/tally.service" "$UNITS/tally-tray.service" "$UNITS/tally-sampler.service" "$UNITS/tally-sampler.timer"
systemctl --user daemon-reload

echo "removed the tally units. ~/.cache/tally and ~/.config/tally are untouched."
