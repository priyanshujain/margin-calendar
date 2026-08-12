// A month you can throw the anchor at. It marks today, marks the span the grid is currently
// showing, and dims the days that belong to the neighbouring months.
//
// The bare `MiniMonth` carries no overlay chrome, so it works as a hover popover from the header
// as well as inside the centred panel that `MiniMonthOverlay` puts around it. Arrow keys move a
// cursor while it has focus; a click or Enter is what actually commits.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { spanFor, useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { addDays, isSameDay, today } from "../time";
import { Icon } from "./Icon";
import {
  addMonths,
  isSameMonth,
  monthGrid,
  monthLabel,
  startOfMonth,
  weekdayHeads,
} from "./overlayModel";
import { Sheet } from "./overlayShell";

const PREV = "M15 18l-6-6 6-6";
const NEXT = "M9 18l6-6-6-6";

export interface MiniMonthProps {
  /** The month to open on and where the cursor starts. Defaults to the view's anchor. */
  anchor?: number;
  /** Defaults to moving the view's anchor. */
  onPick?: (day: number) => void;
  /** Takes the focus on mount, which is what makes the arrow keys reachable. */
  autoFocus?: boolean;
}

export function MiniMonth({ anchor, onPick, autoFocus }: MiniMonthProps) {
  const viewAnchor = useCalendarView((s) => s.anchor);
  const view = useCalendarView((s) => s.view);
  const jumpTo = useCalendarView((s) => s.jumpTo);

  const base = anchor ?? viewAnchor;
  const [cursor, setCursor] = useState(base);
  const [month, setMonth] = useState(() => startOfMonth(base));
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCursor(base);
    setMonth(startOfMonth(base));
  }, [base]);

  useEffect(() => {
    if (autoFocus) root.current?.focus();
  }, [autoFocus]);

  const days = useMemo(() => monthGrid(month), [month]);
  const heads = useMemo(() => weekdayHeads(), []);
  const span = useMemo(() => spanFor(view, viewAnchor), [view, viewAnchor]);
  const now = today();

  const pick = useCallback(
    (day: number) => {
      if (onPick) onPick(day);
      else jumpTo(day);
    },
    [onPick, jumpTo],
  );

  const move = (delta: number) => {
    const next = addDays(cursor, delta);
    setCursor(next);
    setMonth(startOfMonth(next));
  };

  const shiftMonth = (delta: number) => {
    const next = addMonths(month, delta);
    setMonth(next);
    setCursor(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : e.key === "ArrowDown" ? 7 : 0;
    if (step !== 0) {
      e.preventDefault();
      e.stopPropagation();
      move(step);
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      e.stopPropagation();
      shiftMonth(e.key === "PageUp" ? -1 : 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      pick(cursor);
      return;
    }
    if (e.key === "t") {
      e.preventDefault();
      e.stopPropagation();
      pick(now);
    }
  };

  return (
    <div
      className="mini"
      ref={root}
      tabIndex={-1}
      data-autofocus={autoFocus ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="mini-head">
        <button
          type="button"
          className="icon-button"
          title="Previous month (⇞)"
          onClick={() => shiftMonth(-1)}
        >
          <Icon d={PREV} />
        </button>
        <span className="mini-label">{monthLabel(month)}</span>
        <button type="button" className="icon-button" title="Next month (⇟)" onClick={() => shiftMonth(1)}>
          <Icon d={NEXT} />
        </button>
      </div>

      <div className="mini-week">
        {heads.map((head, i) => (
          <span key={i} className="mini-weekday">
            {head}
          </span>
        ))}
      </div>

      <div className="mini-grid">
        {days.map((day) => (
          <button
            type="button"
            key={day}
            className="mini-day"
            tabIndex={-1}
            data-today={day === now || undefined}
            data-outside={!isSameMonth(day, month) || undefined}
            data-span={(day >= span.from && day < span.to) || undefined}
            data-cursor={isSameDay(day, cursor) || undefined}
            onClick={() => pick(day)}
          >
            {new Date(day).getDate()}
          </button>
        ))}
      </div>

      <div className="mini-foot">
        <button type="button" className="panel-button" data-variant="ghost" onClick={() => pick(now)}>
          Today
        </button>
      </div>
    </div>
  );
}

/** The centred form, routed from `useOverlays` on `mini-month`. */
export function MiniMonthOverlay() {
  const open = useOverlays((s) => s.open);
  const close = useOverlays((s) => s.close);
  const jumpTo = useCalendarView((s) => s.jumpTo);

  const pick = useCallback(
    (day: number) => {
      jumpTo(day);
      close();
    },
    [jumpTo, close],
  );

  return (
    <Sheet open={open === "mini-month"} title="Jump to" size="mini" onClose={close}>
      <MiniMonth autoFocus onPick={pick} />
    </Sheet>
  );
}

export default MiniMonth;
