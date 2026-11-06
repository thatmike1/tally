#!/usr/bin/env bash
# install the headless Codex meter on an always-on machine that runs no tally
# server (the VPS): a five-minute timer that appends one weekly reading to
# ~/.cache/tally/codex-usage.jsonl, which the desktop's sampler copies through
# CODEX_SOURCES. it needs node 22 and a logged-in codex, nothing else.
#
#   pnpm run build:codex-meter              # on the desktop, writes dist/codex-meter.mjs
#   scp dist/codex-meter.mjs systemd/tally-codex-meter.* systemd/install-codex-meter.sh host:/tmp/tally-codex-meter/
#   ssh host bash /tmp/tally-codex-meter/install-codex-meter.sh
#
# as root the units go to /etc/systemd/system, otherwise to the user manager.
# re-running replaces the bundle and re-renders the units. --uninstall takes
# them off again and leaves the log alone.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $EUID -eq 0 ]]; then
  UNITS=/etc/systemd/system
  LIB=/opt/tally-codex-meter
  CTL=(systemctl)
else
  UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  LIB="${XDG_DATA_HOME:-$HOME/.local/share}/tally-codex-meter"
  CTL=(systemctl --user)
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  "${CTL[@]}" disable --now tally-codex-meter.timer 2>/dev/null || true
  rm -f "$UNITS/tally-codex-meter.service" "$UNITS/tally-codex-meter.timer"
  "${CTL[@]}" daemon-reload
  echo "removed the codex meter units; $HOME/.cache/tally/codex-usage.jsonl stays"
  exit 0
fi

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" ]]; then
  for candidate in "$HERE/codex-meter.mjs" "$HERE/../dist/codex-meter.mjs"; do
    [[ -f "$candidate" ]] && BUNDLE="$candidate" && break
  done
fi
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || { echo "no codex-meter.mjs: run 'pnpm run build:codex-meter' and pass its path" >&2; exit 1; }
for unit in tally-codex-meter.service tally-codex-meter.timer; do
  [[ -f "$HERE/$unit" ]] || { echo "missing $unit beside this script" >&2; exit 1; }
done

NODE="$(command -v node)" || { echo "node 22 or newer is needed" >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( major >= 22 )) || { echo "node $major is too old; the meter needs 22 or newer" >&2; exit 1; }
CODEX="${CODEX_BIN:-$(command -v codex || true)}"
[[ -n "$CODEX" ]] || { echo "no codex on PATH; install it or set CODEX_BIN" >&2; exit 1; }
CODEX="$(command -v "$CODEX")"
UNIT_PATH="$(dirname "$NODE"):$(dirname "$CODEX"):/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LIB" "$UNITS"
install -m 0644 "$BUNDLE" "$LIB/codex-meter.mjs"
render() {
  sed -e "s|@HOME@|$HOME|g" -e "s|@PATH@|$UNIT_PATH|g" -e "s|@CODEX@|$CODEX|g" \
      -e "s|@NODE@|$NODE|g" -e "s|@METER@|$LIB/codex-meter.mjs|g" "$HERE/$1" > "$UNITS/$1"
}
render tally-codex-meter.service
render tally-codex-meter.timer

"${CTL[@]}" daemon-reload
"${CTL[@]}" enable --now tally-codex-meter.timer
echo "installed: $LIB/codex-meter.mjs, units in $UNITS"
echo "first reading now:"
"${CTL[@]}" start tally-codex-meter.service || true
tail -n 1 "$HOME/.cache/tally/codex-usage.jsonl" 2>/dev/null || echo "(no reading yet; see: ${CTL[*]} status tally-codex-meter.service)"
