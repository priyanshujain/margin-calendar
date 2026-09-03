// Week and day. Day is week with one column: same fit, same packing, same everything, so there is
// one component and a day count rather than two views that drift apart.
//
// The grid never scrolls. The body is measured with a ResizeObserver and handed to `computeFit`,
// which solves the row height for whatever is left after the day bar and the all-day band, so
// resizing the window rescales the day instead of growing a scrollbar. The one exception is the
// escape hatch: when the row height hits its floor the fit says `overflow` and the body scrolls.
//
// A finger and a mouse mean different things by the same press. A mouse press on empty grid can
// only be the start of a drag, because a mouse has nothing else to do here; a finger press is
// ambiguous until it either stays put or travels, so the grid waits it out. Everything that
// follows from that is in `begin`, `arm` and `onPointerMove`.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { eventCreate, eventUpdate } from "../api/events";
import { computeBounds, computeFit, timeToY, yToTime, type Bounds, type Fold } from "../grid/fit";
import { loadBounds, saveBounds } from "../grid/folds";
import { useCalendarView } from "../store/useCalendarView";
import { notify } from "../store/useToast";
import {
  MINUTES_PER_DAY,
  addDays,
  dayName,
  startOfDay,
  weekAnchor,
  toOffsetIso,
  today,
} from "../time";
import { useHourStart } from "../useClock";
import { PHONE_QUERY, useMediaQuery } from "../useMedia";
import "../styles/grid.css";
import "../styles/folds.css";
import { GridAllDay } from "./GridAllDay";
import { GridDay } from "./GridDay";
import { GridDraft } from "./GridDraft";
import { GridGaps } from "./GridGaps";
import { GridGhost } from "./GridGhost";
import {
  MIN_EVENT_MINUTES,
  clampMinutes,
  dayMinutes,
  heldHours,
  hourLabel,
  inBand,
  isVisible,
  keyId,
  keyOf,
  minutesToMs,
  snapMinutes,
  vars,
  type Placed,
  type Times,
} from "./GridModel";
import { GridNowLine } from "./GridNowLine";
import { GridStrip } from "./GridStrip";
import { useGrid, type Drag, type DragMode } from "./GridStore";

/** Half hour rules stop earning their ink below this row height. */
const HALF_RULE_MIN_ROW = 34;

/** Pointer travel before a press becomes a drag rather than a click. */
const DRAG_SLOP = 3;

/**
 * The same for a finger, which cannot hold to three pixels: a still thumb wanders further than
 * that, and every one of those pixels used to be read as the start of a drag.
 */
const TOUCH_SLOP = 12;

/**
 * How long a finger has to stay down before the grid takes the gesture as a drag.
 *
 * A press is the one thing a touchscreen cannot spend freely. It is how you tap, how you swipe and
 * how you drag, and the grid cannot tell which it is watching until the finger either travels or
 * stays. Long enough that a swipe is never mistaken for a create, short enough that holding still
 * feels answered rather than ignored.
 */
const LONG_PRESS_MS = 350;

/**
 * Sideways travel that pages the view instead. Deliberately well past `TOUCH_SLOP`, so the drift
 * in a press that meant to stay put cannot turn into navigation.
 */
const SWIPE_MIN = 60;

/**
 * What a long press on empty grid drags out on its own, so a press that never travels still leaves
 * something behind. Mirrors `NEW_MINUTES` in keys/commands.ts: `c` and a long press are the same
 * act with a different limb.
 */
const TOUCH_CREATE_MINUTES = 60;

/**
 * Whether this press is a finger, which is a question about the gesture rather than about the
 * device. Read off the event rather than off `(pointer: coarse)` on purpose: a tablet with a
 * trackpad attached reports a coarse primary pointer all day and still wants the mouse rules for
 * whatever is actually in your hand.
 */
const isCoarse = (e: ReactPointerEvent): boolean =>
  e.pointerType === "touch" || e.pointerType === "pen";

interface Override extends Times {
  /** The write came back; the next batch of instances is allowed to take over. */
  settled: boolean;
}

interface Gesture {
  pointerId: number;
  mode: DragMode;
  item: Placed | null;
  colsLeft: number;
  colsWidth: number;
  canvasTop: number;
  downX: number;
  downY: number;
  originDay: number;
  originMin: number;
  baseStart: number;
  baseEnd: number;
  /** The pointer has travelled past the slop, so the drag follows it from here on. */
  moved: boolean;
  coarse: boolean;
  /** A finger that is down but has not earned the drag yet: still a tap, a swipe or a long press. */
  pending: boolean;
  /** The long press, cancelled the moment the press turns into anything else. */
  timer: number | null;
}

export interface GridViewProps {
  /** Where a dragged-out event lands. Falls back to the calendar most of the span already uses. */
  defaultCalendarId?: string;
}

export function GridView({ defaultCalendarId }: GridViewProps) {
  const view = useCalendarView((s) => s.view);
  const anchor = useCalendarView((s) => s.anchor);
  const instances = useCalendarView((s) => s.instances);
  const selected = useCalendarView((s) => s.selected);
  const select = useCalendarView((s) => s.select);
  const moveDay = useCalendarView((s) => s.moveDay);
  const setView = useCalendarView((s) => s.setView);
  const setAnchor = useCalendarView((s) => s.setAnchor);

  // Layout only. Which gesture rules apply is decided per press, off the pointer itself.
  const phone = useMediaQuery(PHONE_QUERY);

  const folds = useGrid((s) => s.folds);
  const floor = useGrid((s) => s.floor);
  const dragId = useGrid((s) => s.drag?.id ?? null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const colsRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const hoverRef = useRef<number | null>(null);
  const previous = useRef<Bounds>(loadBounds());
  const saved = useRef("");

  const [viewportH, setViewportH] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});

  // The window is the only input to the row height, so the body measures itself and nothing else
  // in the tree gets a say. Measured before paint, so the first frame is already the right shape.
  //
  // This is a callback ref rather than an effect on mount. Switching to the agenda unmounts this
  // body and switching back mounts a different element, so an effect with an empty dependency list
  // would keep observing the discarded node and solve the axis for a stale height for the rest of
  // the session. The ref fires for every element that actually takes the role.
  const observerRef = useRef<ResizeObserver | null>(null);
  const setBody = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    bodyRef.current = el;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1].contentRect.height;
      setViewportH((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
    });
    observer.observe(el);
    observerRef.current = observer;
    setViewportH(el.clientHeight);
  }, []);

  // An optimistic move survives until the instance that replaces it arrives.
  useEffect(() => {
    setOverrides((prev) => {
      const next: Record<string, Override> = {};
      let dropped = false;
      for (const [id, value] of Object.entries(prev)) {
        if (value.settled) dropped = true;
        else next[id] = value;
      }
      return dropped ? next : prev;
    });
  }, [instances]);

  const days = useMemo(() => {
    const count = view === "day" ? 1 : 7;
    const first = count === 1 ? startOfDay(anchor) : weekAnchor(anchor);
    return Array.from({ length: count }, (_, i) => addDays(first, i));
  }, [view, anchor]);

  const banded = useMemo(
    () => instances.filter((i) => isVisible(i) && inBand(i)),
    [instances],
  );

  /** Timed, single day, inside the span, with any optimistic move already applied. */
  const byDay = useMemo(() => {
    const buckets = new Map<number, Placed[]>();
    for (const day of days) buckets.set(day, []);
    for (const instance of instances) {
      if (!isVisible(instance)) continue;
      const id = keyId(keyOf(instance));
      const override = overrides[id];
      const times: Times = override
        ? { startMs: override.startMs, endMs: override.endMs }
        : { startMs: instance.startMs, endMs: instance.endMs };
      if (inBand(instance, times)) continue;
      const bucket = buckets.get(startOfDay(times.startMs));
      if (bucket) bucket.push({ instance, id, ...times });
    }
    return days.map((day) => buckets.get(day) as Placed[]);
  }, [instances, days, overrides]);

  const timed = useMemo(() => byDay.flat(), [byDay]);

  // The hour the clock is in, when today is one of the columns. Keyed on the hour rather than the
  // minute, because that is how often the answer changes. The line itself moves every minute, on
  // its own tick, in `GridNowLine`.
  const hourStart = useHourStart();
  const nowHour = useMemo(
    () => (days.includes(startOfDay(hourStart)) ? new Date(hourStart).getHours() : null),
    [days, hourStart],
  );

  // The hours nothing may hide: every hour an event on screen covers, and the hour it is now, so
  // the now line always has a row to land in. They are carved out of every strip alike, the ones
  // outside the bounds and the ones you folded, and the bounds themselves stay the events' business.
  const held = useMemo(() => heldHours(timed, nowHour), [timed, nowHour]);

  // Hysteresis needs the bounds it adopted last pass, so they live in a ref rather than in state:
  // paging a week must not reflow the axis, and a render loop through state would fight that.
  const layout = useMemo(() => {
    const auto = computeBounds(timed, previous.current);
    const bounds = floor
      ? { start: Math.min(auto.start, floor.start), end: Math.max(auto.end, floor.end) }
      : auto;
    previous.current = bounds;
    return computeFit({ bounds, folds, hold: held, viewportHeight: viewportH });
  }, [timed, folds, floor, viewportH, held]);

  useEffect(() => {
    const signature = `${layout.bounds.start} ${layout.bounds.end}`;
    if (signature === saved.current) return;
    saved.current = signature;
    saveBounds(layout.bounds);
  }, [layout.bounds]);

  const publish = useGrid((s) => s.publish);
  useEffect(() => {
    if (viewportH > 0) publish(layout, days, held);
  }, [publish, layout, days, held, viewportH]);

  const todayMs = today();
  const todayIndex = days.findIndex((d) => d === todayMs);

  const rules = useMemo(() => {
    const out: { key: string; y: number; half: boolean }[] = [];
    const half = layout.rowHeight >= HALF_RULE_MIN_ROW;
    for (const segment of layout.segments) {
      if (segment.kind !== "hours") continue;
      for (let m = segment.start; m < segment.end; m += 60) {
        out.push({ key: `h${m}`, y: timeToY(layout, m), half: false });
        if (half && m + 30 < segment.end) {
          out.push({ key: `m${m}`, y: timeToY(layout, m + 30), half: true });
        }
      }
    }
    return out;
  }, [layout]);

  const labels = useMemo(() => {
    const out: { hour: number; y: number }[] = [];
    for (const segment of layout.segments) {
      if (segment.kind !== "hours") continue;
      for (let m = segment.start; m < segment.end; m += 60) {
        out.push({ hour: m / 60, y: timeToY(layout, m) });
      }
    }
    return out;
  }, [layout]);

  const unfold = useGrid((s) => s.unfold);
  const onUnfold = useCallback((range: Fold) => unfold(range), [unfold]);

  const columnAt = (clientX: number, left: number, width: number): number => {
    const index = Math.floor(((clientX - left) / Math.max(width, 1)) * days.length);
    return Math.max(0, Math.min(days.length - 1, index));
  };

  /**
   * A fold is not somewhere you can drop things. `yToTime` reads a pixel inside a strip as the
   * first minute it hides, which is right for reading and wrong for dragging: pulling an edge one
   * hour up into the leading strip would jump it to midnight. So a drag that reaches a fold stops
   * at the near side of it, judged from where the gesture started.
   */
  const minuteAt = (clientY: number, canvasTop: number, anchor = 0): number => {
    const raw = yToTime(layout, clientY - canvasTop);
    const segment = layout.segments.find((s) => raw >= s.start && raw < s.end);
    if (segment?.kind === "strip") return segment.start >= anchor ? segment.start : segment.end;
    return snapMinutes(raw);
  };

  const clearPress = (g: Gesture) => {
    if (g.timer === null) return;
    clearTimeout(g.timer);
    g.timer = null;
  };

  /** Drop the gesture without committing anything: a swipe, a cancel, an unmount. */
  const abandon = (pointerId: number) => {
    const g = gesture.current;
    if (g) clearPress(g);
    gesture.current = null;
    try {
      canvasRef.current?.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    useGrid.getState().setDrag(null);
  };

  /**
   * The long press landed, so the press becomes the drag a mouse would have started on the way
   * down. It arrives already `moved`, which is what lets a press that never travels leave a draft
   * behind: a finger that has held still for a third of a second has said what it wants, and
   * asking it to also drag out a duration before anything happens is asking twice.
   *
   * `g.moved` stays false, so the slop below still applies. Without that the hour this opens with
   * would collapse to fifteen minutes on the first tremor.
   */
  const arm = (g: Gesture) => {
    if (gesture.current !== g) return;
    g.pending = false;
    g.timer = null;
    const end =
      g.mode === "create" ? Math.min(MINUTES_PER_DAY, g.baseStart + TOUCH_CREATE_MINUTES) : g.baseEnd;
    useGrid.getState().setDrag({
      mode: g.mode,
      id: g.item?.id ?? null,
      dayIndex: g.originDay,
      startMin: g.baseStart,
      endMin: end,
      moved: true,
    });
  };

  const begin = (
    e: ReactPointerEvent,
    mode: DragMode,
    item: Placed | null,
    dayIndex: number,
    baseStart: number,
    baseEnd: number,
  ) => {
    const canvas = canvasRef.current;
    const cols = colsRef.current;
    if (!canvas || !cols) return;
    const colsRect = cols.getBoundingClientRect();
    const canvasTop = canvas.getBoundingClientRect().top;
    const coarse = isCoarse(e);
    const g: Gesture = {
      pointerId: e.pointerId,
      mode,
      item,
      colsLeft: colsRect.left,
      colsWidth: colsRect.width,
      canvasTop,
      downX: e.clientX,
      downY: e.clientY,
      originDay: dayIndex,
      originMin: minuteAt(e.clientY, canvasTop),
      baseStart,
      baseEnd,
      moved: false,
      coarse,
      pending: coarse,
      timer: null,
    };
    gesture.current = g;
    // A pointer that has already gone throws here, and a gesture is not worth a broken render.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the gesture still works, it just stops at the window edge */
    }
    if (coarse) {
      g.timer = window.setTimeout(() => arm(g), LONG_PRESS_MS);
      return;
    }
    useGrid.getState().setDrag({
      mode,
      id: item?.id ?? null,
      dayIndex,
      startMin: baseStart,
      endMin: baseEnd,
      moved: false,
    });
  };

  // A long press outliving its own grid would arm a drag into a component that is no longer there.
  useEffect(
    () => () => {
      if (gesture.current) clearPress(gesture.current);
    },
    [],
  );

  const onPointerDownBlock = useCallback(
    (e: ReactPointerEvent, item: Placed, mode: DragMode) => {
      if (e.button !== 0 || gesture.current) return;
      e.stopPropagation();
      select(keyOf(item.instance));
      const dayStart = startOfDay(item.startMs);
      const index = days.findIndex((d) => d === dayStart);
      if (index === -1) return;
      const { startMin, endMin } = dayMinutes(item, dayStart);
      // A block nothing can be done to is still something a swipe has to travel through. The press
      // is stopped here rather than on the canvas, so without this the page turn was dead over
      // every read-only event, which on a day with a couple of meetings marked busy is most of the
      // column. It gets a gesture with no long press behind it: the only thing it can become is
      // the swipe, and there is no item on it to commit a move to.
      const inert = item.instance.readOnly || useGrid.getState().draft !== null;
      if (inert && !isCoarse(e)) return;
      begin(e, mode, inert ? null : item, index, startMin, endMin);
      if (inert && gesture.current) clearPress(gesture.current);
    },
    // `begin` closes over the current layout and days, which is what a fresh gesture wants.
    [days, layout, select],
  );

  const onPointerDownCanvas = (e: ReactPointerEvent) => {
    if (e.button !== 0 || gesture.current) return;
    if (e.target instanceof Element && e.target.closest("[data-no-drag]")) return;
    const cols = colsRef.current;
    if (!cols) return;
    const rect = cols.getBoundingClientRect();
    if (e.clientX < rect.left) return;
    if (useGrid.getState().draft) {
      useGrid.getState().setDraft(null);
      return;
    }
    // Everything past this point is the grid's gesture, so the browser is told not to follow it up
    // with the mouse events it sends after a touch. They arrive once the gesture is over and land
    // wherever the finger happens to be: on the create card that has just opened under it, whose
    // input they blur before a single letter can be typed, or on an event on the day a swipe has
    // just paged to. The presses that are still a click, on a block, a strip or a chip, have all
    // returned above.
    if (isCoarse(e)) e.preventDefault();
    const canvasTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
    const minutes = minuteAt(e.clientY, canvasTop);
    begin(e, "create", null, columnAt(e.clientX, rect.left, rect.width), minutes, minutes);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) {
      const canvasTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
      const hour = Math.floor(yToTime(layout, e.clientY - canvasTop) / 60);
      if (hour !== hoverRef.current) {
        hoverRef.current = hour;
        useGrid.getState().setHoverHour(hour);
      }
      return;
    }
    if (e.pointerId !== g.pointerId) return;

    const dx = e.clientX - g.downX;
    const dy = e.clientY - g.downY;

    // A finger that is still deciding. Sideways and far enough is the page turn; anything else
    // that travels is at least not a long press, so the timer goes and the gesture lives on as a
    // swipe candidate until the finger comes up.
    if (g.pending) {
      if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) {
        abandon(g.pointerId);
        // One day, whichever view is up. A week that jumped a week per swipe would be a week you
        // could never land on the day you meant.
        moveDay(dx > 0 ? -1 : 1);
        return;
      }
      if (Math.abs(dx) > TOUCH_SLOP || Math.abs(dy) > TOUCH_SLOP) clearPress(g);
      return;
    }

    if (!g.moved) {
      const slop = g.coarse ? TOUCH_SLOP : DRAG_SLOP;
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;
      g.moved = true;
    }

    const minutes = minuteAt(e.clientY, g.canvasTop, g.originMin);
    const column = columnAt(e.clientX, g.colsLeft, g.colsWidth);
    let next: Drag;
    if (g.mode === "create") {
      const start = Math.min(g.originMin, minutes);
      const end = Math.max(g.originMin, minutes);
      next = {
        mode: g.mode,
        id: null,
        dayIndex: g.originDay,
        startMin: start,
        endMin: Math.max(end, start + MIN_EVENT_MINUTES),
        moved: true,
      };
    } else if (g.mode === "move") {
      const duration = g.baseEnd - g.baseStart;
      const start = Math.min(clampMinutes(g.baseStart + minutes - g.originMin), MINUTES_PER_DAY - duration);
      next = {
        mode: g.mode,
        id: g.item?.id ?? null,
        dayIndex: column,
        startMin: start,
        endMin: start + duration,
        moved: true,
      };
    } else if (g.mode === "resize-start") {
      next = {
        mode: g.mode,
        id: g.item?.id ?? null,
        dayIndex: g.originDay,
        startMin: Math.min(minutes, g.baseEnd - MIN_EVENT_MINUTES),
        endMin: g.baseEnd,
        moved: true,
      };
    } else {
      next = {
        mode: g.mode,
        id: g.item?.id ?? null,
        dayIndex: g.originDay,
        startMin: g.baseStart,
        endMin: Math.max(minutes, g.baseStart + MIN_EVENT_MINUTES),
        moved: true,
      };
    }
    useGrid.getState().setDrag(next);
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    clearPress(g);
    gesture.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // A press that came up before the long press landed has no drag behind it, so this falls
    // through to the tap: deselect on empty grid, and the block's own handler opens its card.
    const drag = useGrid.getState().drag;
    useGrid.getState().setDrag(null);
    if (!drag || !drag.moved) {
      if (g.mode === "create") select(null);
      return;
    }
    if (g.mode === "create") {
      useGrid.getState().setDraft({
        dayIndex: drag.dayIndex,
        startMin: drag.startMin,
        endMin: drag.endMin,
      });
      return;
    }
    if (g.item) void commitMove(g.item, drag);
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    if (!gesture.current || e.pointerId !== gesture.current.pointerId) return;
    abandon(e.pointerId);
  };

  async function commitMove(item: Placed, drag: Drag) {
    const dayStart = days[drag.dayIndex];
    if (dayStart === undefined) return;
    const startMs = minutesToMs(dayStart, drag.startMin);
    const endMs = minutesToMs(dayStart, drag.endMin);
    if (startMs === item.startMs && endMs === item.endMs) return;

    setOverrides((prev) => ({ ...prev, [item.id]: { startMs, endMs, settled: false } }));
    try {
      await eventUpdate(
        keyOf(item.instance),
        { start: toOffsetIso(startMs), end: toOffsetIso(endMs) },
        "this",
      );
      setOverrides((prev) => ({ ...prev, [item.id]: { startMs, endMs, settled: true } }));
      void useCalendarView.getState().load();
    } catch (error) {
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      notify(String(error));
    }
  }

  const fallbackCalendar = useMemo(() => {
    const tally = new Map<string, number>();
    for (const i of instances) {
      if (i.readOnly) continue;
      tally.set(i.calendarId, (tally.get(i.calendarId) ?? 0) + 1);
    }
    let best: string | undefined;
    let most = 0;
    for (const [id, n] of tally) {
      if (n > most) {
        most = n;
        best = id;
      }
    }
    return best;
  }, [instances]);

  async function commitDraft(title: string) {
    const draft = useGrid.getState().draft;
    if (!draft) return;
    const dayStart = days[draft.dayIndex];
    const calendarId = defaultCalendarId ?? fallbackCalendar;
    if (dayStart === undefined || !calendarId) {
      useGrid.getState().setDraft(null);
      notify("No calendar to create in yet.");
      return;
    }
    useGrid.getState().setSaving(true);
    try {
      await eventCreate({
        calendarId,
        summary: title || "Untitled",
        start: toOffsetIso(minutesToMs(dayStart, draft.startMin)),
        end: toOffsetIso(minutesToMs(dayStart, draft.endMin)),
        allDay: false,
      });
      useGrid.getState().setDraft(null);
      void useCalendarView.getState().load();
    } catch (error) {
      notify(String(error));
    } finally {
      useGrid.getState().setSaving(false);
    }
  }

  const cancelDraft = useCallback(() => useGrid.getState().setDraft(null), []);

  /**
   * The way out of a week you cannot read. Seven columns in a phone's width is an overview and
   * nothing more, so the day bar, which is the one part of the grid that stays a comfortable size,
   * doubles as the control that opens the column you tapped.
   *
   * `setView` first: it re-parks the anchor on entry, and the load that lands should be the day's.
   */
  const openDay = useCallback(
    (day: number) => {
      setView("day");
      setAnchor(day);
    },
    [setView, setAnchor],
  );

  if (view === "agenda") return null;

  return (
    <div
      className="grid"
      data-view={view}
      data-overflow={layout.overflow || undefined}
      style={vars({ "--days": days.length, "--row-h": `${layout.rowHeight}px` })}
    >
      <div className="grid-head">
        <div className="grid-head-gutter" />
        <div className="grid-head-days">
          {days.map((day, i) => (
            <button
              type="button"
              key={day}
              className="grid-head-day"
              title={`Open ${dayName(day)} ${new Date(day).getDate()}`}
              data-today={day === todayMs || undefined}
              data-past={day < todayMs || undefined}
              data-index={i}
              onClick={() => openDay(day)}
            >
              {/* A phone week gives a column fifty pixels. "Wed" in fifty pixels next to its date
                  is two things fighting, and the date is the one you navigate by. */}
              <span className="grid-head-name">
                {phone && view === "week" ? dayName(day).charAt(0) : dayName(day)}
              </span>
              <span className="grid-head-date">{new Date(day).getDate()}</span>
            </button>
          ))}
        </div>
      </div>

      <GridAllDay days={days} instances={banded} selected={selected} onSelect={select} />

      <div className="grid-body" ref={setBody}>
        <div
          className="grid-canvas"
          ref={canvasRef}
          style={{ height: `${layout.totalHeight}px` }}
          onPointerDown={onPointerDownCanvas}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            if (!gesture.current) {
              hoverRef.current = null;
              useGrid.getState().setHoverHour(null);
            }
          }}
        >
          <div className="grid-gutter">
            {labels.map((label) => (
              <span key={label.hour} className="grid-gutter-label" style={{ top: `${label.y}px` }}>
                {hourLabel(label.hour)}
              </span>
            ))}
          </div>

          <div className="grid-rules">
            {rules.map((rule) => (
              <span
                key={rule.key}
                className="grid-rule"
                data-half={rule.half || undefined}
                style={{ top: `${rule.y}px` }}
              />
            ))}
          </div>

          {layout.segments.map((segment) =>
            segment.kind === "strip" ? (
              <GridStrip key={`s${segment.start}`} segment={segment} onUnfold={onUnfold} />
            ) : null,
          )}

          <GridGaps />

          <div className="grid-cols" ref={colsRef}>
            {days.map((day, i) => (
              <GridDay
                key={day}
                layout={layout}
                dayStart={day}
                index={i}
                items={byDay[i]}
                selected={selected}
                dragId={dragId}
                past={day < todayMs}
                today={day === todayMs}
                onPointerDownBlock={onPointerDownBlock}
              />
            ))}
            {todayIndex !== -1 && (
              <GridNowLine layout={layout} dayStart={days[todayIndex]} dayIndex={todayIndex} />
            )}
            <GridGhost />
            <GridDraft onCommit={commitDraft} onCancel={cancelDraft} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default GridView;
