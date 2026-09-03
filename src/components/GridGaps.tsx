// The collapse half of folding, by pointer.
//
// A folded band is already a thing you can see and click. An empty one was not: `z` folded the run
// under the cursor and nothing on screen said so. Hovering any empty run of an hour or more now
// lights the whole run, draws the rule the strip would leave behind, and hangs a labelled chip off
// the left edge of the columns.
//
// A finger has no hover, so it would never see any of that: on a coarse pointer every empty run
// carries its own chip instead, and the wash goes, since a preview that is always on is not a
// preview and seven of them would stripe the grid.
//
// Everything here is absolutely positioned inside the canvas, so the affordance cannot feed back
// into the fit. Pointing at a run never moves an hour.

import { memo, useMemo } from "react";
import { isFolded, timeToY, type Fold, type FitLayout } from "../grid/fit";
import { TOUCH_QUERY, useMediaQuery } from "../useMedia";
import { rangeLabel, vars } from "./GridModel";
import { useGrid } from "./GridStore";
import { Icon } from "./Icon";

/**
 * Two arrowheads closing on a line: the run folds onto a strip. Mirrored by `EXPAND_ICON`.
 *
 * The line is what makes them read. Two bare chevrons pointing at each other are a bowtie at this
 * size, which is a close button, and two pointing away are a diamond, which is nothing at all.
 */
export const COLLAPSE_ICON = (
  <>
    <path d="M7 4l5 4 5-4" />
    <path d="M3 12h18" />
    <path d="M7 20l5-4 5 4" />
  </>
);

/** The same pair pointing away from the line: the strip opens back into its hours. */
export const EXPAND_ICON = (
  <>
    <path d="M7 8l5-4 5 4" />
    <path d="M3 12h18" />
    <path d="M7 16l5 4 5-4" />
  </>
);

/** Big enough that three marks stay three marks. Shared with the strip. */
export const FOLD_ICON_SIZE = 16;

/**
 * A run shorter than this has nowhere to put the chip, and folding it would trade its hours for a
 * strip the same height. Only reachable at a row height the grid is already struggling at, and `z`
 * still works there.
 */
const MIN_GAP_H = 24;

/**
 * The empty run around `hour`: nothing scheduled on any visible day, not the hour it is now,
 * nothing already folded, both ends stopped by the bounds. Null when the hour is held, folded or
 * off the axis.
 *
 * This is deliberately not `bandAt`, which is what `z` folds and which walks straight through an
 * existing fold. What the mouse offers has to be exactly what the label says, so a run cut in two
 * by a fold reads as two runs and collapses as the half you pointed at. Folding merges them anyway.
 */
export function gapAt(layout: FitLayout, held: readonly boolean[], hour: number): Fold | null {
  const { start: lo, end: hi } = layout.bounds;
  if (hour < lo || hour >= hi) return null;
  const free = (h: number) => !held[h] && !isFolded(layout, h * 60);
  if (!free(hour)) return null;
  let start = hour;
  let end = hour + 1;
  while (start > lo && free(start - 1)) start--;
  while (end < hi && free(end)) end++;
  return { start, end };
}

/** Every empty run on the axis, which is what a pointer with no hover has to be given instead. */
export function allGaps(layout: FitLayout, held: readonly boolean[]): Fold[] {
  const out: Fold[] = [];
  let hour = layout.bounds.start;
  while (hour < layout.bounds.end) {
    const gap = gapAt(layout, held, hour);
    if (!gap) {
      hour++;
      continue;
    }
    out.push(gap);
    hour = gap.end;
  }
  return out;
}

export const GridGaps = memo(function GridGaps() {
  const layout = useGrid((s) => s.layout);
  const held = useGrid((s) => s.held);
  const hoverHour = useGrid((s) => s.hoverHour);
  // Booleans rather than the objects themselves: this must not repaint on every pointermove.
  const gesturing = useGrid((s) => s.drag !== null || s.draft !== null);
  const fold = useGrid((s) => s.fold);
  const touch = useMediaQuery(TOUCH_QUERY);

  const gaps = useMemo(() => {
    if (!layout) return [];
    if (touch) return allGaps(layout, held);
    const hovered = hoverHour === null ? null : gapAt(layout, held, hoverHour);
    return hovered ? [hovered] : [];
  }, [layout, held, hoverHour, touch]);

  if (!layout || gesturing) return null;

  return (
    <>
      {gaps.map((gap) => {
        const top = timeToY(layout, gap.start * 60);
        const height = timeToY(layout, gap.end * 60) - top;
        if (height < MIN_GAP_H) return null;
        const label = `Collapse ${rangeLabel(gap)}`;
        return (
          <div
            key={gap.start}
            className="grid-gap"
            style={vars({ top: `${top}px`, height: `${height}px` })}
          >
            <div className="grid-gap-bar">
              <button
                type="button"
                className="grid-gap-fold"
                data-no-drag=""
                title={`${label} (z)`}
                aria-label={label}
                onClick={() => fold(gap)}
              >
                <Icon size={FOLD_ICON_SIZE}>{COLLAPSE_ICON}</Icon>
                <span className="grid-fold-verb">Collapse</span>
              </button>
              <span className="grid-gap-rule" />
            </div>
          </div>
        );
      })}
    </>
  );
});
