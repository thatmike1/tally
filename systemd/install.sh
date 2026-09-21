#!/usr/bin/env bash
# install tally as three systemd user units: the page, the tray icon and the
# five-minute sampler that produces the data.
#
# the units in this directory are templates. systemd expands %h but nothing else,
# so the checkout path and the node binary have to be substituted here and the
# result written into ~/.config/systemd/user/ — a checkout anywhere and a node
# from nvm, apt or a version manager all work.
#
# re-running is safe: it re-renders the units, never overwrites an existing
# ~/.config/tally/config.json, and never moves a cache file onto one that exists.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/tally/config.json"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tally"
OLD_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/cc-browse-tray"

# `systemctl cat` is the cheapest "does this unit exist at all" test; is-enabled
# answers for a unit systemd has never heard of
unit_known() { systemctl --user cat "$1" >/dev/null 2>&1; }

# ---- what this machine has -------------------------------------------------

if [[ -x "$HOME/.nvm/nvm-exec" ]]; then
  # nvm-exec resolves NODE_VERSION when the unit starts, so a node upgrade does
  # not leave the unit pointing at a version directory that no longer exists
  NODE="$HOME/.nvm/nvm-exec node"
elif NODE_BIN="$(command -v node)"; then
  NODE="$NODE_BIN"
else
  echo "tally needs node and found none. install it (apt install nodejs, or nvm) and re-run." >&2
  exit 1
fi
echo "checkout: $REPO"
echo "node:     $NODE"

# ---- build -----------------------------------------------------------------

cd "$REPO"
npm ci || npm install
npm run build
chmod +x "$REPO/tray/tally-tray.py" "$REPO/sampler/usage-sample.py"

# ---- migrate off the pre-tally sampler and off symlinked units -------------

if unit_known usage-sample.timer; then
  # disable is a no-op the second time, so only say it when there is something to do
  systemctl --user is-enabled usage-sample.timer >/dev/null 2>&1 && echo "migrating off usage-sample.timer"
  systemctl --user disable --now usage-sample.timer usage-sample.service 2>/dev/null || true
fi

# an earlier install enabled the units by absolute path, which leaves a wants
# symlink into the checkout beside the copy written below
systemctl --user disable tally.service tally-tray.service 2>/dev/null || true

mkdir -p "$CACHE"
# the sampler's four files move; anything already at the new path wins, so a
# half-finished migration is not undone by a second run
for name in limits.jsonl usage-raw.jsonl usage-sample-401 usage-sample-429; do
  if [[ -e "$OLD_CACHE/$name" && ! -e "$CACHE/$name" ]]; then
    mv "$OLD_CACHE/$name" "$CACHE/$name"
    echo "moved $name into $CACHE"
  fi
done

# a drop-in is the user's own config (USAGE_UPSTREAM lives here, and it decides
# which machine talks to the endpoint), so carry it over and never clobber it
mkdir -p "$UNITS"
if compgen -G "$UNITS/usage-sample.service.d/*" >/dev/null; then
  mkdir -p "$UNITS/tally-sampler.service.d"
  for conf in "$UNITS/usage-sample.service.d/"*; do
    [[ -e "$UNITS/tally-sampler.service.d/$(basename "$conf")" ]] || cp "$conf" "$UNITS/tally-sampler.service.d/"
  done
  echo "carried the usage-sample drop-in over to tally-sampler.service.d"
fi

# ---- render the units ------------------------------------------------------

for unit in tally.service tally-tray.service tally-sampler.service tally-sampler.timer; do
  sed -e "s|@TALLY_DIR@|$REPO|g" -e "s|@NODE@|$NODE|g" "$HERE/$unit" > "$UNITS/$unit"
done
systemctl --user daemon-reload

# ---- first-run config ------------------------------------------------------

if [[ -e "$CONFIG" ]]; then
  echo "config:   $CONFIG (kept as it is)"
else
  agentsview_url=null
  if command -v agentsview >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/agentsview" ]]; then
    agentsview_url='"http://127.0.0.1:8080"'
  fi
  takeaway=null
  if command -v agy >/dev/null 2>&1; then
    takeaway='{ "command": "agy", "model": "gemini-3.8-flash-low" }'
  fi
  # a tray row is only useful when the unit behind it exists: the row starts it
  links=
  if unit_known bd-board.service; then
    links='{ "name": "bd-board", "url": "http://127.0.0.1:1338", "unit": "bd-board.service" }'
  fi
  toggles=
  if unit_known agentsview.service; then
    toggles='{ "name": "AgentsView", "url": "http://127.0.0.1:8080", "unit": "agentsview.service" }'
  fi
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<EOF
{
  "port": 1337,
  "plan":      { "name": "Max 5x", "usdPerMonth": 100 },
  "codexPlan": { "name": "ChatGPT Pro", "usdPerMonth": 100 },
  "agentsviewUrl": $agentsview_url,
  "takeaway": $takeaway,
  "tray": {
    "links":   [ $links ],
    "toggles": [ $toggles ]
  }
}
EOF
  echo "config:   $CONFIG (written from what this machine has; edit it, install never overwrites it)"
fi

# ---- start -----------------------------------------------------------------

systemctl --user enable tally.service tally-tray.service tally-sampler.timer >/dev/null
# restart rather than `enable --now`, which leaves an already-running unit on the
# code from before this build
systemctl --user restart tally.service tally-sampler.timer
systemctl --user restart tally-tray.service ||
  echo "the tray did not start; it needs a graphical session and will come up at your next login"

echo
systemctl --user --no-pager --lines=0 status tally.service tally-tray.service tally-sampler.timer || true
echo
port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CONFIG" | head -1)"
echo "page:      http://127.0.0.1:${port:-1337}"
echo "uninstall: $HERE/uninstall.sh"
