// The phone's chrome: a top bar for where you are, a bottom bar for what you are looking at, and a
// sheet for everything else.
//
// The desktop header puts three groups on one row and reaches every panel from an icon in the
// trailing one. At 390px that row is about twice the width there is, so it splits: the date and the
// day arrows stay at the top where a thumb can still get at them, the view switch and the one
// action worth a permanent button move to the bottom where the thumb already is, and the rest goes
// behind the overflow. Nothing new is invented here, every control runs the same command a key or
// a menu item does.

import { Icon } from "./Icon";
import {
  CALENDAR,
  CHEVRON_LEFT,
  CHEVRON_RIGHT,
  GEAR,
  MOON,
  REFRESH,
  SEARCH,
  SUN,
} from "./Header";
import { Sheet } from "./overlayShell";
import { commandLabel, runCommand, type CommandId } from "../keys/commands";
import { spanFor, useCalendarView, type View } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { useTheme } from "../store/useTheme";
import { addDays, isSameDay, monthName, dayName, today } from "../time";

const MORE = "M4 7h16M4 12h16M4 17h16";
const PLUS = "M12 5v14M5 12h14";
const PERSON = "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z";
const KEYBOARD =
  "M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1zM7 10h.01M11 10h.01M15 10h.01M17 10h.01M7 14h10";

const VIEWS: { id: View; label: string; command: CommandId }[] = [
  { id: "day", label: "Day", command: "view-day" },
  { id: "week", label: "Week", command: "view-week" },
  { id: "agenda", label: "Agenda", command: "view-agenda" },
];

/**
 * The range in the shortest form that is still unambiguous. `formatRange` writes "Wednesday 12
 * August 2026", which is wider than the whole button it has to live in here, so the weekday and the
 * month are cut to three letters and the year is only spelled out when it is not this one.
 */
function shortRange(from: number, to: number): string {
  const a = new Date(from);
  const b = new Date(to);
  const month = (ms: number) => monthName(ms).slice(0, 3);
  const year = a.getFullYear() === new Date(today()).getFullYear() ? "" : ` ${a.getFullYear()}`;

  if (isSameDay(from, to)) return `${dayName(from).slice(0, 3)} ${a.getDate()} ${month(from)}${year}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
    return `${a.getDate()} to ${b.getDate()} ${month(from)}${year}`;
  return `${a.getDate()} ${month(from)} to ${b.getDate()} ${month(to)}${year}`;
}

export function PhoneTopBar() {
  const view = useCalendarView((s) => s.view);
  const anchor = useCalendarView((s) => s.anchor);
  const moveDay = useCalendarView((s) => s.moveDay);
  const goToday = useCalendarView((s) => s.goToday);
  const toggle = useOverlays((s) => s.toggle);

  const { from, to } = spanFor(view, anchor);

  // A title attribute is a hover, and there is no hover here, so every control carries its name
  // rather than a tooltip nobody can summon.
  return (
    <header className="phonebar">
      <button
        type="button"
        className="icon-button"
        aria-label="Previous day"
        onClick={() => moveDay(-1)}
      >
        <Icon d={CHEVRON_LEFT} size={20} />
      </button>
      <button type="button" className="phonebar-range" onClick={() => toggle("mini-month")}>
        {shortRange(from, addDays(to, -1))}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Next day"
        onClick={() => moveDay(1)}
      >
        <Icon d={CHEVRON_RIGHT} size={20} />
      </button>
      <button type="button" className="phonebar-today" onClick={goToday}>
        Today
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Menu"
        onClick={() => toggle("menu")}
      >
        <Icon d={MORE} size={20} />
      </button>
    </header>
  );
}

/** The primary navigation, which is why it is the one thing on screen that is never a hover away. */
export function PhoneTabBar() {
  const view = useCalendarView((s) => s.view);

  return (
    <nav className="tabbar" aria-label="Views">
      <div className="tabbar-views" role="group">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="tabbar-view"
            data-active={view === v.id}
            onClick={() => runCommand(v.command)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="tabbar-new"
        aria-label="New event"
        onClick={() => runCommand("new-event")}
      >
        <Icon d={PLUS} size={20} />
      </button>
    </nav>
  );
}

/** Everything the desktop reaches from the header's trailing icons or from a key it does not have. */
export function PhoneMenu() {
  const open = useOverlays((s) => s.open);
  const close = useOverlays((s) => s.close);
  const theme = useTheme((s) => s.theme);

  const items: { command: CommandId; icon: string; label: string }[] = [
    { command: "search", icon: SEARCH, label: commandLabel("search") },
    { command: "calendars", icon: CALENDAR, label: commandLabel("calendars") },
    { command: "settings", icon: GEAR, label: commandLabel("settings") },
    { command: "accounts", icon: PERSON, label: commandLabel("accounts") },
    { command: "sync-now", icon: REFRESH, label: commandLabel("sync-now") },
    {
      command: "toggle-theme",
      icon: theme === "dark" ? SUN : MOON,
      // "Toggle dark mode" reads as a state on a row this wide, and half the time it is the wrong
      // one. Name the thing the tap will get you instead.
      label: theme === "dark" ? "Light mode" : "Dark mode",
    },
    { command: "shortcuts", icon: KEYBOARD, label: commandLabel("shortcuts") },
  ];

  const choose = (command: CommandId) => {
    runCommand(command);
    const overlays = useOverlays.getState();
    // Still here, so the row acted in place rather than opening a panel. Only the theme is worth
    // staying for: the sheet repaints under your thumb, so changing your mind costs one tap.
    if (overlays.open === "menu") {
      if (command !== "toggle-theme") close();
      return;
    }
    // A panel replaced the sheet. It was opened by a command, which cannot know it was reached
    // from here, so the way back is recorded after the fact.
    overlays.reachedFrom("menu");
  };

  return (
    <Sheet open={open === "menu"} title="Menu" onClose={close}>
      <div className="menu-list">
        {items.map((item) => (
          <button
            key={item.command}
            type="button"
            className="menu-item"
            onClick={() => choose(item.command)}
          >
            <Icon d={item.icon} size={18} />
            <span className="menu-label">{item.label}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
