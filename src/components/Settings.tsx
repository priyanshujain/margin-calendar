// Global preferences, and only the ones that genuinely are global. Everything else about this app
// is a key away, which is the point of it, so there is nothing here to pad the panel with.

import { useState } from "react";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { useTheme } from "../store/useTheme";
import { setWeekStartDay, weekStartDay } from "../time";
import { Sheet } from "./overlayShell";

export function Settings() {
  const open = useOverlays((s) => s.open);
  const close = useOverlays((s) => s.close);
  const push = useOverlays((s) => s.push);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);
  const accounts = useAccounts((s) => s.accounts);
  const [start, setStart] = useState<0 | 1>(() => (weekStartDay() === 0 ? 0 : 1));

  const chooseTheme = (next: "light" | "dark") => {
    if (next !== theme) toggleTheme();
  };

  const chooseStart = (day: 0 | 1) => {
    if (day === start) return;
    setWeekStartDay(day);
    setStart(day);
    // The week span is derived from this on every read, so nudge the view into recomputing it.
    useCalendarView.getState().setAnchor(useCalendarView.getState().anchor);
  };

  return (
    <Sheet
      open={open === "settings"}
      title="Settings"
      onClose={close}
      foot={
        <button type="button" className="panel-button" data-autofocus="" onClick={close}>
          Done
        </button>
      }
    >
      <div className="setting-row">
        <span className="setting-name">Theme</span>
        <div className="segment">
          <button
            type="button"
            className="segment-option"
            data-on={theme === "light" || undefined}
            onClick={() => chooseTheme("light")}
          >
            Light
          </button>
          <button
            type="button"
            className="segment-option"
            data-on={theme === "dark" || undefined}
            onClick={() => chooseTheme("dark")}
          >
            Dark
          </button>
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-text">
          <span className="setting-name">Week starts on</span>
          <span className="setting-note">
            Week view begins on this day rather than on today. The arrows and h and l still slide
            it a day at a time when you want a look either side.
          </span>
        </span>
        <div className="segment">
          <button
            type="button"
            className="segment-option"
            data-on={start === 0 || undefined}
            onClick={() => chooseStart(0)}
          >
            Sunday
          </button>
          <button
            type="button"
            className="segment-option"
            data-on={start === 1 || undefined}
            onClick={() => chooseStart(1)}
          >
            Monday
          </button>
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-text">
          <span className="setting-name">Accounts</span>
          <span className="setting-note">
            {accounts.length === 0
              ? "No Google account connected yet."
              : `${accounts.length} connected.`}
          </span>
        </span>
        <button type="button" className="panel-button" onClick={() => push("accounts")}>
          Manage
        </button>
      </div>
    </Sheet>
  );
}

export default Settings;
