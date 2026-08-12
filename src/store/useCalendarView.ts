import { create } from "zustand";
import { instancesRange } from "../api/instances";
import { live, type Instance, type InstanceKey } from "../ipc";
import { addDays, startOfDay, startOfWeek, today, weekAnchor } from "../time";

export type View = "day" | "week" | "agenda";

const VIEW_KEY = "margincal-view";

function initialView(): View {
  const attr = document.documentElement.getAttribute("data-view");
  if (attr === "day" || attr === "week" || attr === "agenda") return attr;
  const saved = localStorage.getItem(VIEW_KEY);
  return saved === "day" || saved === "agenda" ? saved : "week";
}

/** The half-open span the view is showing, in epoch milliseconds. */
export function spanFor(view: View, anchor: number): { from: number; to: number } {
  if (view === "day") return { from: anchor, to: addDays(anchor, 1) };
  if (view === "agenda") return { from: anchor, to: addDays(anchor, 30) };
  const from = weekAnchor(anchor);
  return { from, to: addDays(from, 7) };
}

function sameKey(a: InstanceKey | null, b: InstanceKey | null): boolean {
  if (!a || !b) return a === b;
  return a.eventId === b.eventId && a.originalStart === b.originalStart;
}

interface CalendarViewState {
  view: View;
  anchor: number;
  instances: Instance[];
  phase: "idle" | "loading" | "error";
  error: string | null;
  selected: InstanceKey | null;
  setView: (view: View) => void;
  /** Raw. Slides the window without re-deciding where a week begins. */
  setAnchor: (anchor: number) => void;
  /** Shows the week containing that day, parked on the configured start of the week. */
  jumpTo: (ms: number) => void;
  goToday: () => void;
  moveDay: (delta: number) => void;
  moveWeek: (delta: number) => void;
  select: (key: InstanceKey | null) => void;
  selectAdjacent: (delta: number) => void;
  load: () => Promise<void>;
}

export const useCalendarView = create<CalendarViewState>((set, get) => ({
  view: initialView(),
  // Week view opens on the configured start of the week, not on today, so a week always begins on
  // the same day. The arrows and h/l slide it from there as a temporary look.
  anchor: initialView() === "week" ? startOfWeek(today()) : today(),
  instances: [],
  phase: "idle",
  error: null,
  selected: null,
  setView: (view) => {
    localStorage.setItem(VIEW_KEY, view);
    document.documentElement.setAttribute("data-view", view);
    // Entering the week re-parks on a boundary, so a slide left over from day navigation does not
    // decide where the week starts.
    const anchor = view === "week" ? startOfWeek(get().anchor) : get().anchor;
    set({ view, anchor });
    void get().load();
  },
  setAnchor: (anchor) => {
    set({ anchor: startOfDay(anchor) });
    void get().load();
  },
  goToday: () => get().jumpTo(today()),
  jumpTo: (ms) => get().setAnchor(get().view === "week" ? startOfWeek(ms) : startOfDay(ms)),
  moveDay: (delta) => get().setAnchor(addDays(get().anchor, delta)),
  moveWeek: (delta) => get().setAnchor(addDays(get().anchor, delta * 7)),
  select: (key) => set({ selected: key }),
  selectAdjacent: (delta) => {
    const { instances, selected } = get();
    // Day first, then all-day before timed within that day, matching what both the agenda and the
    // grid put on screen. Filtering all-day out here would make j and k skip rows the user is
    // looking at.
    const ordered = instances
      .filter((i) => i.status !== "cancelled")
      .slice()
      .sort(
        (a, b) =>
          startOfDay(a.startMs) - startOfDay(b.startMs) ||
          Number(b.allDay) - Number(a.allDay) ||
          a.startMs - b.startMs ||
          a.eventId.localeCompare(b.eventId),
      );
    if (ordered.length === 0) return;
    const at = ordered.findIndex((i) =>
      sameKey({ eventId: i.eventId, originalStart: i.originalStart }, selected),
    );
    const next = at === -1 ? (delta > 0 ? 0 : ordered.length - 1) : at + delta;
    const target = ordered[Math.max(0, Math.min(ordered.length - 1, next))];
    set({ selected: { eventId: target.eventId, originalStart: target.originalStart } });
  },
  load: async () => {
    if (!live()) return;
    const { view, anchor } = get();
    // A day of padding either side, so a block that starts before the span still renders.
    const { from, to } = spanFor(view, anchor);
    set({ phase: "loading", error: null });
    try {
      const instances = await instancesRange(addDays(from, -1), addDays(to, 1));
      // Ignore a response that landed after the view moved on.
      const now = get();
      if (now.view !== view || now.anchor !== anchor) return;
      set({ instances, phase: "idle" });
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },
}));
