#!/usr/bin/python3
"""GNOME tray icon for tally: the three meters, plus the local pages and units the menu opens."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
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

URL = os.environ.get("TALLY_URL", "http://127.0.0.1:1337")
API_STATE_URL = f"{URL}/api/state?peek"
SERVICE = "tally.service"
SAMPLER_SERVICE = "usage-sample.service"
POLL_SECS = 60
HERE = Path(__file__).resolve().parent

# the rows below came over from cc-browse-tray when it was retired. ports are
# ours, not framework defaults: 1338 bd-board
#
# the other local pages the menu opens, each a user unit that autostarts
PAGES = (
    ("bd-board", "bd-board.service", "http://127.0.0.1:1338"),
)

# agentsview is too heavy to leave running (~7% of a core while sessions write),
# so its unit is linked but not enabled and the menu toggles it
AGENTSVIEW_UNIT = "agentsview.service"
AGENTSVIEW_URL = "http://127.0.0.1:8080"


def fmt_hm(t: float) -> str:
    """a unix time as a local `13:10`, the way the server's widget prints it."""
    return datetime.fromtimestamp(t).astimezone().strftime("%H:%M")


def pct_of(value) -> int:
    """a meter percentage rounded half up, matching the widget's Math.round."""
    return int(float(value or 0) + 0.5)


def fetch_state() -> dict | None:
    """fetch state from tally without moving the last-looked marker."""
    try:
        req = urllib.request.Request(API_STATE_URL, headers={"User-Agent": "tally-tray"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
        return None
    return None


def port_open(url: str) -> bool:
    """whether something listens behind a local url; a bare connect, no request."""
    host, port = url.rsplit("/", 1)[-1].rsplit(":", 1)
    try:
        socket.create_connection((host, int(port)), timeout=0.2).close()
        return True
    except OSError:
        return False


def service_running(unit: str) -> bool:
    r = subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", unit], check=False
    )
    return r.returncode == 0


def local_status() -> dict:
    """what the action rows depend on: whether AgentsView is up."""
    return {
        # judged by the port, so an `agentsview serve` started by hand counts too
        "agentsview": port_open(AGENTSVIEW_URL),
    }


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


def action_rows(cbs: dict, status: dict) -> list[tuple[str, str | None, object]]:
    """the pages the menu opens and the units it toggles.

    a row whose label and action flip together carries the state in its key, so
    the shape changes and the menu re-binds the callback.
    """
    rows: list[tuple[str, str | None, object]] = [
        ("open", "Open tally", cbs.get("open")),
    ]
    for name, _unit, url in PAGES:
        port = url.rsplit(":", 1)[1]
        rows.append((f"open-{name}", f"Open {name} ({port})", cbs.get(f"open-{name}")))
    if status.get("agentsview"):
        rows.append(("av-open", "Open AgentsView (8080)", cbs.get("av-open")))
        rows.append(("av-stop", "Stop AgentsView", cbs.get("av-stop")))
    else:
        rows.append(("av-start", "Start AgentsView", cbs.get("av-start")))
    rows.append(("sep-actions", None, None))
    rows.append(("refresh", "Refresh", cbs.get("refresh")))
    rows.append(("quit", "Quit", cbs.get("quit")))
    return rows


def build_plan(
    state: dict | None,
    callbacks: dict | None = None,
    status: dict | None = None,
) -> tuple[str, bool, list[tuple[str, str | None, object]]]:
    """generate (label, alert, plan_rows) from tally state and the local units' status."""
    cbs = callbacks or {}
    stat = status or {}
    if state is None:
        plan = [
            ("down", "tally server is down", None),
            ("start", "Start tally", cbs.get("start")),
            ("sep-down", None, None),
        ]
        # the pages and units do not depend on tally, so they stay reachable
        plan += [row for row in action_rows(cbs, stat) if row[0] not in ("open", "refresh")]
        return "–", False, plan

    label, alert, plan = meter_rows(state)
    plan.append(("sep-meters", None, None))
    plan += action_rows(cbs, stat)
    return label, alert, plan


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

        self.callbacks = {
            "open": self.on_open,
            "refresh": self.on_refresh,
            "quit": self.on_quit,
            "start": self.on_start_tally,
            "av-open": lambda _w: subprocess.Popen(["xdg-open", AGENTSVIEW_URL], start_new_session=True),
            "av-stop": self.on_agentsview_stop,
            "av-start": self.page_opener(AGENTSVIEW_UNIT, AGENTSVIEW_URL),
        }
        for name, unit, url in PAGES:
            self.callbacks[f"open-{name}"] = self.page_opener(unit, url)

        self.poll()
        GLib.timeout_add_seconds(POLL_SECS, self.poll)

    def poll(self) -> bool:
        state = fetch_state()
        self.update_with_state(state)
        return True

    def update_with_state(self, state: dict | None) -> None:
        label, alert, plan = build_plan(state, self.callbacks, local_status())
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
        subprocess.Popen(["xdg-open", URL], start_new_session=True)

    def on_refresh(self, _w=None) -> None:
        if self.refresh_busy:
            return
        self.refresh_busy = True

        def work():
            subprocess.run(["systemctl", "--user", "start", SAMPLER_SERVICE], check=False)
            self.refresh_busy = False
            GLib.idle_add(self.poll)

        threading.Thread(target=work, daemon=True).start()

    def on_start_tally(self, _w=None) -> None:
        def work():
            subprocess.run(["systemctl", "--user", "start", SERVICE], check=False)
            for _ in range(20):
                try:
                    urllib.request.urlopen(API_STATE_URL, timeout=1).close()
                    break
                except OSError:
                    time.sleep(0.25)
            GLib.idle_add(self.poll)

        threading.Thread(target=work, daemon=True).start()

    def page_opener(self, unit: str, url: str):
        """open a page served by a user unit, starting the unit first if it is down.

        a node server needs a moment to bind after `systemctl start`, so the wait
        for the port runs off the main loop and the browser opens once it answers.
        """

        def work() -> None:
            if not service_running(unit):
                subprocess.run(["systemctl", "--user", "start", unit], check=False)
                for _ in range(20):
                    try:
                        urllib.request.urlopen(url, timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.25)
                GLib.idle_add(self.poll)
            subprocess.Popen(["xdg-open", url], start_new_session=True)

        return lambda _w: threading.Thread(target=work, daemon=True).start()

    def on_agentsview_stop(self, _w=None) -> None:
        """stop the unit, and a hand-started server if the port still answers."""

        def work() -> None:
            subprocess.run(["systemctl", "--user", "stop", AGENTSVIEW_UNIT], check=False)
            if port_open(AGENTSVIEW_URL):
                subprocess.run([str(Path.home() / ".local/bin/agentsview"), "serve", "stop"], check=False)
            GLib.idle_add(self.poll)

        threading.Thread(target=work, daemon=True).start()

    def on_quit(self, _w=None) -> None:
        Gtk.main_quit()


def print_menu_rows() -> int:
    state = fetch_state()
    label, alert, plan = build_plan(state, status=local_status())
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
