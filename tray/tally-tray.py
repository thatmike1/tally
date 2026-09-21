#!/usr/bin/python3
"""GNOME tray icon for tally: the three meters, plus the local pages and units the menu opens.

Which pages and units those are is not baked in: they come from the `tray`
section of `~/.config/tally/config.json`, the same file the server reads, read at
startup and again on Refresh. `links` rows open a url (starting their unit first
if the port is closed), `toggles` rows start and stop a unit. Both default to
empty, so a machine with no config gets the meters and nothing else.

Env:
  TALLY_CONFIG  path to the config file, default `$XDG_CONFIG_HOME/tally/config.json`
                (`~/.config/tally/config.json` when XDG_CONFIG_HOME is unset).
                point it at a scratch file to see what the menu would look like
                on another machine: `TALLY_CONFIG=/tmp/c.json ... --print`.
  TALLY_URL     tally's base url, default `http://127.0.0.1:<config port>`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator

from gi.repository import GLib, Gtk

SERVICE = "tally.service"
# the sampler was renamed when it moved into this repo; an older install still
# has the cc-browse-tray name, so Refresh takes whichever one systemd knows
SAMPLER_SERVICES = ("tally-sampler.service", "usage-sample.service")
DEFAULT_PORT = 1337
POLL_SECS = 60
HERE = Path(__file__).resolve().parent


def config_path() -> Path:
    """`$XDG_CONFIG_HOME/tally/config.json`, else under `~/.config`, unless TALLY_CONFIG says otherwise.

    the same resolution as `server/config.ts` and `systemd/install.sh`, so all
    three read and write one file.
    """
    override = os.environ.get("TALLY_CONFIG")
    if override:
        return Path(override)
    xdg = (os.environ.get("XDG_CONFIG_HOME") or "").strip()
    return Path(xdg or Path.home() / ".config") / "tally/config.json"


def default_config() -> dict:
    """what the tray runs on with no config file: the default port, no extra rows."""
    return {"port": DEFAULT_PORT, "tray": {"links": [], "toggles": []}}


def parse_rows(raw: object) -> list[dict]:
    """the well-formed rows of a `tray.links` / `tray.toggles` list.

    a row needs a name and a url; the unit is optional here and required later
    for toggles. two rows with the same name would share a menu key and so a
    callback, so the second one is dropped rather than shadowing the first.
    """
    rows: list[dict] = []
    if not isinstance(raw, list):
        return rows
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        url = item.get("url")
        unit = item.get("unit")
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(url, str) or not url.strip():
            continue
        name = name.strip()
        if name in seen:
            continue
        seen.add(name)
        unit = unit.strip() if isinstance(unit, str) and unit.strip() else None
        rows.append({"name": name, "url": url.strip(), "unit": unit})
    return rows


def parse_config(raw: object) -> dict:
    """the slice of the config file the tray uses, with every default filled in.

    pure, so the menu shape is testable without a config file on disk. every key
    is optional and a malformed value falls back to its default instead of
    raising: a hand-edited config must never stop the tray from coming up. keys
    the server owns (plan, agentsviewUrl, takeaway) are ignored here.
    """
    cfg = default_config()
    if not isinstance(raw, dict):
        return cfg
    port = raw.get("port")
    if isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536:
        cfg["port"] = port
    tray = raw.get("tray")
    if isinstance(tray, dict):
        cfg["tray"]["links"] = parse_rows(tray.get("links"))
        cfg["tray"]["toggles"] = parse_rows(tray.get("toggles"))
    return cfg


def load_config(path: Path | None = None) -> dict:
    """read and parse the config file, then drop the toggles systemd cannot run.

    a toggle row is a promise that Start works, so a unit systemd has never heard
    of is dropped instead of being offered and failing silently. links are left
    alone: their unit is a best effort before opening the url.
    """
    try:
        raw = json.loads((path or config_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = None
    cfg = parse_config(raw)
    cfg["tray"]["toggles"] = [
        row for row in cfg["tray"]["toggles"] if row["unit"] and unit_known(row["unit"])
    ]
    return cfg


def tally_url(config: dict) -> str:
    """tally's base url: the env override wins, otherwise the configured port."""
    return os.environ.get("TALLY_URL") or f"http://127.0.0.1:{config.get('port', DEFAULT_PORT)}"


def fmt_hm(t: float) -> str:
    """a unix time as a local `13:10`, the way the server's widget prints it."""
    return datetime.fromtimestamp(t).astimezone().strftime("%H:%M")


def pct_of(value) -> int:
    """a meter percentage rounded half up, matching the widget's Math.round."""
    return int(float(value or 0) + 0.5)


def state_url(base: str) -> str:
    return f"{base.rstrip('/')}/api/state?peek"


def fetch_state(base: str) -> dict | None:
    """fetch state from tally without moving the last-looked marker."""
    try:
        req = urllib.request.Request(state_url(base), headers={"User-Agent": "tally-tray"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
        return None
    return None


def url_port(url: str) -> str | None:
    """the port a url names, or None when it leaves it to the scheme."""
    try:
        return str(urllib.parse.urlsplit(url).port or "") or None
    except ValueError:
        return None


def open_label(name: str, url: str) -> str:
    """`Open bd-board (1338)`, or without the port when the url does not name one."""
    port = url_port(url)
    return f"Open {name} ({port})" if port else f"Open {name}"


def port_open(url: str) -> bool:
    """whether something listens behind a local url; a bare connect, no request."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return False
    if not host:
        return False
    try:
        socket.create_connection((host, port), timeout=0.2).close()
        return True
    except OSError:
        return False


def service_running(unit: str) -> bool:
    r = subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", unit], check=False
    )
    return r.returncode == 0


def unit_known(unit: str) -> bool:
    """whether systemd has a unit file for this name; `cat` exits 1 when it does not."""
    r = subprocess.run(
        ["systemctl", "--user", "cat", unit],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return r.returncode == 0


def sampler_service() -> str:
    for unit in SAMPLER_SERVICES:
        if unit_known(unit):
            return unit
    return SAMPLER_SERVICES[0]


def local_status(config: dict) -> dict:
    """what the action rows depend on: which toggled units are up right now."""
    # judged by the port, so an `agentsview serve` started by hand counts too
    return {row["name"]: port_open(row["url"]) for row in config["tray"]["toggles"]}


def meter_rows(state: dict) -> tuple[str, bool, list[tuple[str, str | None, object]]]:
    """the label, the alert flag and the three meter lines.

    the lines are the same text the T3 widget shows (`server/widget.ts`
    `computeRows`), so the two glance faces never disagree.
    """
    codex = state.get("codex") or {}
    codex_line = codex.get("line") or "Codex · unavailable"
    five_hour = state.get("fiveHour")
    if not five_hour:
        return "–", False, [("codex", codex_line, None), ("5h", "5h  no samples yet", None)]

    pct = pct_of(five_hour.get("pct"))
    resets_at = five_hour.get("resetsAt")
    ended = bool(five_hour.get("ended"))
    next_resets_at = five_hour.get("nextResetsAt")
    expired = bool(five_hour.get("expired"))
    age_seconds = float(five_hour.get("ageSeconds") or 0)

    block = state.get("block") or {}
    proj = block.get("projection") or {}
    hits_hundred_at = proj.get("hitsHundredAt")
    has_pace = bool(proj.get("ready"))

    hits_before_reset = (
        hits_hundred_at is not None
        and resets_at is not None
        and hits_hundred_at <= resets_at
    )
    # a finished block's projection is history, not a warning
    alert = (not ended and (pct >= 100 or (has_pace and hits_before_reset))) or expired or age_seconds > 900
    label = f"{pct}%{'!' if alert else ''}"

    if ended:
        verdict = "fresh block"
    elif not has_pace:
        verdict = "no pace yet"
    elif hits_hundred_at is not None:
        verdict = f"100% at {fmt_hm(hits_hundred_at)}"
    else:
        verdict = "you make it"

    if expired:
        reset_part = "  ·  expired"
    elif ended:
        reset_part = f"  ·  resets {fmt_hm(next_resets_at)} if you start now" if next_resets_at else ""
    elif resets_at:
        reset_part = f"  ·  resets {fmt_hm(resets_at)}"
    else:
        reset_part = ""

    rows: list[tuple[str, str | None, object]] = [("codex", codex_line, None)]
    rows.append(("5h", f"5h  {pct}%{reset_part}  ·  {verdict}", None))

    weekly = state.get("weekly")
    if weekly:
        w_phrase = (weekly.get("verdict") or {}).get("phrase") or "on pace"
        rows.append(("weekly", f"week  {pct_of(weekly.get('pct'))}%  ·  {w_phrase}", None))

    fable = state.get("fable")
    if fable:
        f_model = fable.get("model") or "Fable"
        f_phrase = (fable.get("verdict") or {}).get("phrase") or "on pace"
        rows.append(("fable", f"{f_model}  {pct_of(fable.get('pct'))}%  ·  {f_phrase}", None))

    return label, alert, rows


def action_rows(
    cbs: dict, status: dict, config: dict | None = None
) -> list[tuple[str, str | None, object]]:
    """the pages the menu opens and the units it toggles, both from the config.

    a row whose label and action flip together carries the state in its key, so
    the shape changes and the menu re-binds the callback. empty link and toggle
    lists are the normal case on a machine with no config: the rows are absent,
    nothing is greyed out.
    """
    cfg = config or default_config()
    rows: list[tuple[str, str | None, object]] = [
        ("open", "Open tally", cbs.get("open")),
    ]
    for row in cfg["tray"]["links"]:
        name = row["name"]
        rows.append((f"open-{name}", open_label(name, row["url"]), cbs.get(f"open-{name}")))
    for row in cfg["tray"]["toggles"]:
        name = row["name"]
        if status.get(name):
            rows.append((f"{name}-open", open_label(name, row["url"]), cbs.get(f"{name}-open")))
            rows.append((f"{name}-stop", f"Stop {name}", cbs.get(f"{name}-stop")))
        else:
            rows.append((f"{name}-start", f"Start {name}", cbs.get(f"{name}-start")))
    rows.append(("sep-actions", None, None))
    rows.append(("refresh", "Refresh", cbs.get("refresh")))
    rows.append(("quit", "Quit", cbs.get("quit")))
    return rows


def build_plan(
    state: dict | None,
    callbacks: dict | None = None,
    status: dict | None = None,
    config: dict | None = None,
) -> tuple[str, bool, list[tuple[str, str | None, object]]]:
    """generate (label, alert, plan_rows) from tally state and the local units' status."""
    cbs = callbacks or {}
    stat = status or {}
    cfg = config or default_config()
    if state is None:
        plan = [
            ("down", "tally server is down", None),
            ("start", "Start tally", cbs.get("start")),
            ("sep-down", None, None),
        ]
        # the pages and units do not depend on tally, so they stay reachable
        plan += [row for row in action_rows(cbs, stat, cfg) if row[0] not in ("open", "refresh")]
        return "–", False, plan

    label, alert, plan = meter_rows(state)
    plan.append(("sep-meters", None, None))
    plan += action_rows(cbs, stat, cfg)
    return label, alert, plan


def unit_serve_argv(unit: str) -> list[str] | None:
    """the unit's ExecStart as argv, expanded by systemd (so `%h` is a real path)."""
    r = subprocess.run(
        ["systemctl", "--user", "show", "-p", "ExecStart", unit],
        check=False,
        capture_output=True,
        text=True,
    )
    m = re.search(r"argv\[\]=(.*?) ;", r.stdout or "")
    if not m:
        return None
    try:
        return shlex.split(m.group(1))
    except ValueError:
        return None


class Tray:
    def __init__(self):
        self.ind = AppIndicator.Indicator.new_with_path(
            "tally-tray",
            "tally-symbolic",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
            str(HERE / "icons/hicolor/scalable/status"),
        )
        self.ind.set_attention_icon_full("tally-attention-symbolic", "alert")
        self.ind.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.menu = Gtk.Menu()
        self.ind.set_menu(self.menu)

        self.shape: list = []
        self.labels: list[Gtk.Label] = []
        self.refresh_busy = False
        self.plan: list = []

        self.apply_config(load_config())

        self.poll()
        GLib.timeout_add_seconds(POLL_SECS, self.poll)

    def apply_config(self, config: dict) -> None:
        """adopt a config: the url to poll, and a callback per configured row.

        called again on Refresh, so a row added to the file shows up without a
        restart. the callbacks close over their row's unit and url, so they are
        rebuilt whole rather than patched.
        """
        self.config = config
        self.url = tally_url(config)
        self.callbacks = {
            "open": self.on_open,
            "refresh": self.on_refresh,
            "quit": self.on_quit,
            "start": self.on_start_tally,
        }
        for row in config["tray"]["links"]:
            self.callbacks[f"open-{row['name']}"] = self.page_opener(row["unit"], row["url"])
        for row in config["tray"]["toggles"]:
            name = row["name"]
            self.callbacks[f"{name}-open"] = self.url_opener(row["url"])
            self.callbacks[f"{name}-start"] = self.page_opener(row["unit"], row["url"])
            self.callbacks[f"{name}-stop"] = self.unit_stopper(row["unit"], row["url"])

    def poll(self) -> bool:
        state = fetch_state(self.url)
        self.update_with_state(state)
        return True

    def poll_once(self) -> bool:
        """poll from a one-shot idle callback.

        an idle source repeats until its callback returns False, so the timer's
        `poll` (which returns True to stay on its 60s tick) cannot be handed to
        `idle_add` directly: it would re-arm itself and fetch state in a loop.
        """
        self.poll()
        return False

    def update_with_state(self, state: dict | None) -> None:
        label, alert, plan = build_plan(
            state, self.callbacks, local_status(self.config), self.config
        )
        self.ind.set_label(label, "100%!")
        self.ind.set_status(
            AppIndicator.IndicatorStatus.ATTENTION
            if alert
            else AppIndicator.IndicatorStatus.ACTIVE
        )
        self.plan = plan
        self.apply_plan()

    def apply_plan(self) -> None:
        shape = [key for key, _label, _cb in self.plan]
        if shape == self.shape:
            for (_key, label, _cb), lbl in zip(self.plan, self.labels):
                if label is not None and lbl.get_text() != label:
                    lbl.set_text(label)
            return

        for child in self.menu.get_children():
            self.menu.remove(child)
        self.labels = []
        for key, label, cb_fn in self.plan:
            if key.startswith("sep"):
                self.menu.append(Gtk.SeparatorMenuItem())
                self.labels.append(Gtk.Label())
                continue
            mi = Gtk.MenuItem()
            lbl = Gtk.Label(label=label, xalign=0)
            mi.add(lbl)
            if cb_fn is None:
                mi.set_sensitive(False)
            else:
                mi.connect("activate", cb_fn)
            self.menu.append(mi)
            self.labels.append(lbl)
        self.shape = shape
        self.menu.show_all()

    def on_open(self, _w=None) -> None:
        subprocess.Popen(["xdg-open", self.url], start_new_session=True)

    def on_refresh(self, _w=None) -> None:
        if self.refresh_busy:
            return
        self.refresh_busy = True

        def work():
            subprocess.run(["systemctl", "--user", "start", sampler_service()], check=False)
            self.refresh_busy = False
            GLib.idle_add(self.reload_config_and_poll)

        threading.Thread(target=work, daemon=True).start()

    def reload_config_and_poll(self) -> bool:
        """Refresh re-reads the config, so a row added to the file appears without a restart."""
        self.apply_config(load_config())
        return self.poll_once()

    def on_start_tally(self, _w=None) -> None:
        def work():
            subprocess.run(["systemctl", "--user", "start", SERVICE], check=False)
            for _ in range(20):
                try:
                    urllib.request.urlopen(state_url(self.url), timeout=1).close()
                    break
                except OSError:
                    time.sleep(0.25)
            GLib.idle_add(self.poll_once)

        threading.Thread(target=work, daemon=True).start()

    def url_opener(self, url: str):
        return lambda _w: subprocess.Popen(["xdg-open", url], start_new_session=True)

    def page_opener(self, unit: str | None, url: str):
        """open a page served by a user unit, starting the unit first if it is down.

        a node server needs a moment to bind after `systemctl start`, so the wait
        for the port runs off the main loop and the browser opens once it answers.
        a row with no unit is just a bookmark: nothing to start, open it.
        """

        def work() -> None:
            if unit and not service_running(unit):
                subprocess.run(["systemctl", "--user", "start", unit], check=False)
                for _ in range(20):
                    try:
                        urllib.request.urlopen(url, timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.25)
                GLib.idle_add(self.poll_once)
            subprocess.Popen(["xdg-open", url], start_new_session=True)

        return lambda _w: threading.Thread(target=work, daemon=True).start()

    def unit_stopper(self, unit: str, url: str):
        """stop the unit, and a hand-started server if the port still answers.

        the hand-started case is the one systemd cannot reach, and the unit file
        is what says how to reach it: an ExecStart of the form `<bin> serve ...`
        means `<bin> serve stop` is that server's own shutdown. any other shape
        is left alone rather than guessed at.
        """

        def work() -> None:
            subprocess.run(["systemctl", "--user", "stop", unit], check=False)
            if not port_open(url):
                GLib.idle_add(self.poll_once)
                return
            argv = unit_serve_argv(unit)
            if argv and len(argv) > 1 and argv[1] == "serve":
                subprocess.run([argv[0], "serve", "stop"], check=False)
            GLib.idle_add(self.poll_once)

        return lambda _w: threading.Thread(target=work, daemon=True).start()

    def on_quit(self, _w=None) -> None:
        Gtk.main_quit()


def print_menu_rows() -> int:
    config = load_config()
    state = fetch_state(tally_url(config))
    label, alert, plan = build_plan(state, status=local_status(config), config=config)
    print(f"Label: {label}")
    print("Menu rows:")
    for key, text, _cb in plan:
        if key.startswith("sep"):
            print("  ---")
        else:
            print(f"  {text}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="tally tray icon")
    parser.add_argument("--print", action="store_true", help="print label and menu rows then exit")
    args = parser.parse_args()

    if args.print:
        return print_menu_rows()

    Tray()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
