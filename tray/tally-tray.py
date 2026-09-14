#!/usr/bin/python3
"""GNOME tray icon for tally: 5-hour limit, weekly pace, and session attribution."""

from __future__ import annotations

import argparse
import json
import os
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
TITLE_CHARS = 40
HERE = Path(__file__).resolve().parent


def ellipsis(text: str, cap: int = TITLE_CHARS) -> str:
    """cut to `cap` on a word boundary where one is close enough to the cut."""
    text = " ".join(text.split())
    if len(text) <= cap:
        return text
    head = text[: cap - 1]
    cut = head.rfind(" ")
    return (head[:cut] if cut > cap - 12 else head).rstrip(" ,.;:") + "…"


def fmt_secs(secs: float) -> str:
    """a countdown short enough to sit on a menu line: `4d`, `3h10m`, `12m`."""
    secs = int(secs)
    if secs <= 0:
        return "now"
    if secs >= 86400:
        return f"{secs // 86400}d{(secs % 86400) // 3600}h".removesuffix("0h")
    if secs >= 3600:
        return f"{secs // 3600}h{(secs % 3600) // 60:02d}m"
    return f"{max(1, secs // 60)}m"


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


def build_plan(
    state: dict | None,
    callbacks: dict | None = None,
) -> tuple[str, bool, list[tuple[str, str | None, object]]]:
    """generate (label, alert, plan_rows) from tally state."""
    cbs = callbacks or {}
    if state is None:
        label = "–"
        alert = False
        plan = [
            ("down", "tally server is down", None),
            ("start", "Start tally", cbs.get("start")),
            ("sep-down", None, None),
            ("quit", "Quit", cbs.get("quit")),
        ]
        return label, alert, plan

    five_hour = state.get("fiveHour")
    if not five_hour:
        label = "–"
        alert = False
        line_5h = "5h  no samples yet"
    else:
        pct = int(five_hour.get("pct", 0))
        resets_at = five_hour.get("resetsAt")
        expired = bool(five_hour.get("expired"))
        age_seconds = float(five_hour.get("ageSeconds") or 0)
        now = state.get("now", time.time())

        block = state.get("block") or {}
        proj = block.get("projection") or {}
        hits_hundred_at = proj.get("hitsHundredAt")
        to_t = block.get("to", 0)
        from_t = block.get("from", 0)
        has_pace = to_t > from_t

        hits_before_reset = (
            hits_hundred_at is not None
            and resets_at is not None
            and hits_hundred_at <= resets_at
        )
        alert = hits_before_reset or pct >= 100 or expired or age_seconds > 900
        label = f"{pct}%{'!' if alert else ''}"

        countdown = fmt_secs(resets_at - now) if resets_at else "now"
        reset_part = "expired" if expired else f"resets in {countdown}"

        if not has_pace:
            verdict = "no pace yet"
        elif hits_hundred_at is not None:
            dt = datetime.fromtimestamp(hits_hundred_at).astimezone()
            verdict = f"100% at {dt.strftime('%H:%M')}"
        else:
            verdict = "you make it"

        line_5h = f"5h  {reset_part}  ·  {verdict}"

    plan = [("5h", line_5h, None)]

    weekly = state.get("weekly")
    if weekly:
        w_pct = weekly.get("pct", 0)
        w_phrase = (weekly.get("verdict") or {}).get("phrase")
        line_weekly = f"weekly  {w_pct}%  ·  {w_phrase}" if w_phrase else f"weekly  {w_pct}%"
        plan.append(("weekly", line_weekly, None))

    fable = state.get("fable")
    if fable:
        f_model = fable.get("model") or "Fable"
        f_pct = fable.get("pct", 0)
        f_phrase = (fable.get("verdict") or {}).get("phrase")
        line_fable = f"{f_model}  {f_pct}%  ·  {f_phrase}" if f_phrase else f"{f_model}  {f_pct}%"
        plan.append(("fable", line_fable, None))

    plan.append(("sep-1", None, None))

    split = state.get("split") or {}
    block_sessions = split.get("sessions") or []
    if block_sessions:
        for i, s in enumerate(block_sessions[:3]):
            share_pct = round(s.get("share", 0) * 100)
            title = ellipsis(s.get("title") or s.get("sessionId") or "untitled", 40)
            plan.append((f"b-{i}-{s.get('sessionId')}", f"{share_pct}%  {title}", None))
    else:
        plan.append(("b-empty", "no sessions in block", None))

    plan.append(("sep-2", None, None))

    week = state.get("week") or {}
    fable_split = week.get("fable") or {}
    fable_sessions = fable_split.get("sessions") or []
    if fable_sessions:
        for i, s in enumerate(fable_sessions[:3]):
            share_pct = round(s.get("share", 0) * 100)
            title = ellipsis(s.get("title") or s.get("sessionId") or "untitled", 40)
            plan.append((f"f-{i}-{s.get('sessionId')}", f"{share_pct}%  {title}", None))
    else:
        plan.append(("f-empty", "no Fable sessions", None))

    plan.append(("sep-3", None, None))
    plan.append(("open", "Open tally", cbs.get("open")))
    plan.append(("refresh", "Refresh", cbs.get("refresh")))
    plan.append(("quit", "Quit", cbs.get("quit")))

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

        self.poll()
        GLib.timeout_add_seconds(POLL_SECS, self.poll)

    def poll(self) -> bool:
        state = fetch_state()
        self.update_with_state(state)
        return True

    def update_with_state(self, state: dict | None) -> None:
        callbacks = {
            "open": self.on_open,
            "refresh": self.on_refresh,
            "quit": self.on_quit,
            "start": self.on_start_tally,
        }
        label, alert, plan = build_plan(state, callbacks)
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

    def on_quit(self, _w=None) -> None:
        Gtk.main_quit()


def print_menu_rows() -> int:
    state = fetch_state()
    label, alert, plan = build_plan(state)
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
