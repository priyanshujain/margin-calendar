// The only persistent chrome. It carries the date range, the view switcher and the current time
// range, and on macOS the traffic lights float over it, so it costs no extra height.

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "./Icon";
import { useCalendarView, spanFor, type View } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { useSync } from "../store/useSync";
import { useTheme } from "../store/useTheme";
import { addDays, formatRange } from "../time";
import { keyLabel, keysFor } from "../keys/bindings";
import { isDesktop } from "../ipc";
import type { CommandId } from "../keys/commands";

// Exported where the phone bar shows the same thing: two rows of chrome that disagreed about which
// glyph means "sync" would be two different apps.
export const CHEVRON_LEFT = "M15 18l-6-6 6-6";
export const CHEVRON_RIGHT = "M9 18l6-6-6-6";
const CHEVRONS_LEFT = "M18 18l-6-6 6-6M11 18l-6-6 6-6";
const CHEVRONS_RIGHT = "M6 18l6-6-6-6M13 18l6-6-6-6";
export const GEAR =
  "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z";
export const CALENDAR = "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z";
export const SEARCH = "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35";
export const REFRESH = "M21 12a9 9 0 11-3-6.7M21 3v6h-6";
export const SUN = "M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4";
export const MOON = "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z";

const VIEWS: { id: View; label: string; command: CommandId }[] = [
  { id: "day", label: "Day", command: "view-day" },
  { id: "week", label: "Week", command: "view-week" },
  { id: "agenda", label: "Agenda", command: "view-agenda" },
];

/** The shortcut in real glyphs, for a title attribute. */
function hint(command: CommandId): string {
  const combo = keysFor(command)[0];
  return combo ? ` (${keyLabel(combo)})` : "";
}

export function Header() {
  const view = useCalendarView((s) => s.view);
  const anchor = useCalendarView((s) => s.anchor);
  const setView = useCalendarView((s) => s.setView);
  const moveDay = useCalendarView((s) => s.moveDay);
  const moveWeek = useCalendarView((s) => s.moveWeek);
  const goToday = useCalendarView((s) => s.goToday);
  const toggle = useOverlays((s) => s.toggle);
  const phase = useSync((s) => s.phase);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);
  const pending = useSync((s) => s.pendingWrites);

  const { from, to } = spanFor(view, anchor);
  const step = moveDay;

  // Double click to zoom, the way a native title bar does. Tauri's drag region only handles this
  // when the header itself is the event target, and the layout children cover it end to end, so
  // it is wired explicitly. A double click on a control is not a title bar gesture.
  const onDoubleClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (!isDesktop) return;
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
    void getCurrentWindow().toggleMaximize();
  };

  return (
    <header className="titlebar" data-tauri-drag-region onDoubleClick={onDoubleClick}>
      <div className="lead" data-tauri-drag-region>
        <button
          className="icon-button"
          onClick={() => moveWeek(-1)}
          title={`Previous week${hint("week-prev")}`}
        >
          <Icon d={CHEVRONS_LEFT} />
        </button>
        <button
          className="icon-button"
          onClick={() => step(-1)}
          title={`Previous day${hint("day-prev")}`}
        >
          <Icon d={CHEVRON_LEFT} />
        </button>
        <button
          className="icon-button"
          onClick={() => step(1)}
          title={`Next day${hint("day-next")}`}
        >
          <Icon d={CHEVRON_RIGHT} />
        </button>
        <button
          className="icon-button"
          onClick={() => moveWeek(1)}
          title={`Next week${hint("week-next")}`}
        >
          <Icon d={CHEVRONS_RIGHT} />
        </button>
        <button className="header-today" onClick={goToday} title={`Today${hint("today")}`}>
          Today
        </button>
        <button
          className="header-range"
          onClick={() => toggle("mini-month")}
          title={`Jump to a date${hint("mini-month")}`}
        >
          {formatRange(from, addDays(to, -1))}
        </button>
      </div>

      <div className="view-switch" role="group" data-tauri-drag-region>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className="view-option"
            data-active={view === v.id}
            onClick={() => setView(v.id)}
            title={`${v.label}${hint(v.command)}`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="trail" data-tauri-drag-region>
        <button
          className="icon-button"
          onClick={toggleTheme}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          <Icon d={theme === "dark" ? SUN : MOON} />
        </button>
        <button
          className="icon-button"
          onClick={() => toggle("calendars")}
          title="Calendars"
        >
          <Icon d={CALENDAR} />
        </button>
        <button
          className="icon-button"
          onClick={() => toggle("settings")}
          title={`Settings${hint("settings")}`}
        >
          <Icon d={GEAR} />
        </button>
        <button
          className="icon-button"
          onClick={() => toggle("search")}
          title={`Search${hint("search")}`}
        >
          <Icon d={SEARCH} />
        </button>
        <button
          className="icon-button"
          data-active={phase === "syncing"}
          data-error={phase === "error"}
          onClick={() => useSync.getState().run()}
          title={
            pending > 0
              ? `${pending} waiting to send${hint("sync-now")}`
              : `Sync now${hint("sync-now")}`
          }
        >
          <Icon d={REFRESH} />
        </button>
      </div>
    </header>
  );
}

export default Header;
