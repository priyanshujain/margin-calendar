// Drag out a range and the quick create card appears beside it. Enter commits, Escape puts it back.
// Same event the palette makes, different mood.
//
// This file is the anchor and nothing else: it turns the store's draft into a box over the range
// that was dragged, decides where the card can sit without leaving the grid body or covering the
// range, and hands the rest to `QuickCreateCard`. The range keeps its own shade under the card,
// because it is the only thing the user has said so far and hiding it would be the whole complaint.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEscapeLayer } from "../escape";
import { timeToY } from "../grid/fit";
import { startOfDay } from "../time";
import "../styles/create.css";
import { MIN_BLOCK_H, dayMinutes, minutesToMs, vars } from "./GridModel";
import { useGrid, type Draft } from "./GridStore";
import { QuickCreateCard } from "./QuickCreateCard";
import { placeCard, type Placement, type Slot } from "./QuickCreateModel";

/** Between the range and the card, and between the card and the edge of the grid body. */
const GAP = 8;
const MARGIN = 8;

interface GridDraftProps {
  /**
   * The grid's title-only commit. The card creates the event itself: a title is not enough to say
   * which calendar, where, or when once the fields have been touched. Kept so `GridView` compiles
   * against the same component.
   */
  onCommit?: (title: string) => void;
  onCancel: () => void;
}

export function GridDraft({ onCancel }: GridDraftProps) {
  const draft = useGrid((s) => s.draft);
  const layout = useGrid((s) => s.layout);
  const days = useGrid((s) => s.days);

  useEscapeLayer(draft !== null, onCancel);

  if (!draft || !layout) return null;
  const dayStart = days[draft.dayIndex];
  if (dayStart === undefined) return null;

  // Keyed on the range, so a second draft never inherits the first one's title or its fields.
  return (
    <DraftAnchor
      key={`${dayStart} ${draft.startMin} ${draft.endMin}`}
      draft={draft}
      dayStart={dayStart}
      onClose={onCancel}
    />
  );
}

interface DraftAnchorProps {
  draft: Draft;
  dayStart: number;
  onClose: () => void;
}

function DraftAnchor({ draft, dayStart, onClose }: DraftAnchorProps) {
  const layout = useGrid((s) => s.layout);

  const dragged = useMemo<Slot>(
    () => ({
      startMs: minutesToMs(dayStart, draft.startMin),
      endMs: minutesToMs(dayStart, draft.endMin),
      allDay: false,
    }),
    [dayStart, draft.startMin, draft.endMin],
  );

  const [slot, setSlot] = useState<Slot>(dragged);
  const [place, setPlace] = useState<Placement | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  const card = useRef<HTMLFormElement | null>(null);

  // The shade follows the fields while they stay on this column. A parse that moves the event to
  // another day leaves it where it was drawn and dims it: the sentence in the card carries the
  // truth, and there is no honest place to draw a Thursday on a Tuesday column.
  const onDay = !slot.allDay && startOfDay(slot.startMs) === dayStart;
  const span = onDay ? dayMinutes(slot, dayStart) : { startMin: draft.startMin, endMin: draft.endMin };
  const top = layout ? timeToY(layout, span.startMin) : 0;
  const height = layout ? Math.max(MIN_BLOCK_H, timeToY(layout, span.endMin) - top) : MIN_BLOCK_H;

  useLayoutEffect(() => {
    const box = anchor.current;
    const panel = card.current;
    if (!box || !panel) return;
    const measure = () => {
      const a = box.getBoundingClientRect();
      // The body clips its own overflow, so it is the region the card has to stay inside.
      const body = box.closest(".grid-body")?.getBoundingClientRect();
      const bounds = {
        left: Math.max(MARGIN, (body?.left ?? 0) + MARGIN),
        top: Math.max(MARGIN, (body?.top ?? 0) + MARGIN),
        right: Math.min(window.innerWidth, body?.right ?? window.innerWidth) - MARGIN,
        bottom: Math.min(window.innerHeight, body?.bottom ?? window.innerHeight) - MARGIN,
      };
      const next = placeCard(
        a,
        { width: panel.offsetWidth, height: panel.offsetHeight },
        bounds,
        GAP,
      );
      // Held relative to the range box, so the card rides along with it rather than being replaced.
      const offset = { left: next.left - a.left, top: next.top - a.top, side: next.side };
      setPlace((prev) =>
        prev && prev.left === offset.left && prev.top === offset.top && prev.side === offset.side
          ? prev
          : offset,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(box);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [top, height, draft.dayIndex]);

  return (
    <div
      className="quick-create"
      ref={anchor}
      style={vars({ "--i": draft.dayIndex, top: `${top}px`, height: `${height}px` })}
    >
      <span className="quick-create-range" data-elsewhere={onDay ? undefined : ""} />
      <QuickCreateCard
        ref={card}
        style={{ left: `${place?.left ?? 0}px`, top: `${place?.top ?? 0}px` }}
        side={place?.side ?? "right"}
        placed={place !== null}
        dayStart={dayStart}
        slot={slot}
        onSlot={setSlot}
        dragged={dragged}
        onClose={onClose}
      />
    </div>
  );
}
