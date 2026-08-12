// One block on the axis: a pill filled with its calendar's colour. Not the raw hue, which would
// make a week of grid unreadable, but that hue held at a lightness a whole week of them can be
// read at, with the type drawn from the same hue so it stays legible on top. All this file hands
// CSS is the angle; grid.css owns every level built from it.
//
// The block decides how much of itself to show from its own rendered height. A five minute event
// is 12 pixels tall and still has to be a readable, hittable event rather than a stray rule, so
// the smallest rung of the ladder is a bar with a title on it, not an empty sliver.

import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { formatTime } from "../time";
import {
  blockSize,
  calVars,
  eventTitle,
  isBusy,
  isDeclined,
  keyOf,
  titleLines,
  vars,
  type Placed,
} from "./GridModel";
import { useGrid, type DragMode } from "./GridStore";
import { openDetailsFor } from "./useDetails";

/**
 * Pointer travel that makes a press a drag rather than a click. Mirrors `DRAG_SLOP` and
 * `TOUCH_SLOP` in GridView, which owns the gesture; these are only the backstop for blocks that
 * never start one, since a read-only block is pressed and released without a drag ever existing.
 */
const CLICK_SLOP = 3;
const TOUCH_CLICK_SLOP = 12;

interface GridEventProps {
  item: Placed;
  top: number;
  height: number;
  left: number;
  width: number;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent, item: Placed, mode: DragMode) => void;
}

function edgeMode(target: EventTarget | null): DragMode {
  const el = target instanceof Element ? target.closest("[data-edge]") : null;
  const edge = el?.getAttribute("data-edge");
  return edge === "start" ? "resize-start" : edge === "end" ? "resize-end" : "move";
}

export const GridEvent = memo(function GridEvent({
  item,
  top,
  height,
  left,
  width,
  selected,
  dragging,
  onPointerDown,
}: GridEventProps) {
  const { instance } = item;
  const size = blockSize(height);
  const busy = isBusy(instance);
  const declined = isDeclined(instance);
  const title = eventTitle(instance);

  // A free/busy block's time is where it sits and its place is nobody's business, so the second
  // line would only repeat the axis. Everything else earns one once there is room for it.
  const meta = size === "full" && !busy;

  const open = (element: Element | null) => {
    // A draft owns the grid while it is open; opening a card over it would fight for the escape.
    if (useGrid.getState().draft) return;
    openDetailsFor(keyOf(instance), element);
  };

  /**
   * A click is a press that did not travel. The canvas captures the pointer as soon as a gesture
   * begins, which retargets `pointerup` and the click that follows it away from this block, so
   * the release is watched in the capture phase: that runs before GridView clears the drag, and
   * `moved` is the flag that already knows a drag from a click.
   */
  const press = (e: ReactPointerEvent) => {
    onPointerDown(e, item, edgeMode(e.target));
    if (e.button !== 0) return;
    // The mouse events a browser sends after a touch land once the gesture is over, wherever the
    // finger happens to be. Suppressing them here keeps a press on a block from blurring an open
    // create card. It does not cover the click, which is dealt with where the click is handled.
    if (e.pointerType !== "mouse") e.preventDefault();
    const element = e.currentTarget;
    const downX = e.clientX;
    const downY = e.clientY;
    // A tap is a click a finger made, and a finger wanders. It also has to survive the long press
    // that a drag now waits for: `drag.moved` is what says the press became a gesture instead.
    const slop = e.pointerType === "mouse" ? CLICK_SLOP : TOUCH_CLICK_SLOP;
    const stop = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", stop, true);
    };
    const up = (event: PointerEvent) => {
      stop();
      if (useGrid.getState().drag?.moved) return;
      if (Math.abs(event.clientX - downX) > slop) return;
      if (Math.abs(event.clientY - downY) > slop) return;
      open(element);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", stop, true);
  };

  return (
    <div
      className="grid-event"
      role="button"
      tabIndex={-1}
      title={title}
      data-size={size}
      data-busy={busy || undefined}
      data-declined={declined || undefined}
      data-status={instance.status}
      data-pending={instance.pending || undefined}
      data-readonly={instance.readOnly || undefined}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      style={vars({
        ...calVars(instance),
        "--l": left,
        "--w": width,
        "--lines": busy ? 1 : titleLines(height, meta),
        top: `${top}px`,
        height: `${height}px`,
      })}
      onPointerDown={press}
      // Never fires while the canvas holds the pointer, which is every real gesture with a mouse.
      // It is here for the presses that do not go through a pointer at all, and a click a touch
      // left behind is not one of those: capture does not retarget it, so it arrives however the
      // gesture ended, and a long press meant to pick the block up would open its card as well.
      // The release in `press` is the way in on a touchscreen, and it knows a drag from a tap.
      onClick={(e) => {
        if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
        open(e.currentTarget);
      }}
    >
      <div className="grid-event-text">
        <span className="grid-event-title">{title}</span>
        {meta && (
          <span className="grid-event-time">
            {formatTime(item.startMs)}
            {/* The place is the first thing a narrow block gives up, so it is its own span. */}
            {instance.location && <span className="grid-event-where"> · {instance.location}</span>}
          </span>
        )}
      </div>
      {!instance.readOnly && size !== "bar" && (
        <>
          <span className="grid-event-grip" data-edge="start" />
          <span className="grid-event-grip" data-edge="end" />
        </>
      )}
    </div>
  );
});
