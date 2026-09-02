// A folded band. The empty hours outside the bounds fold themselves; an interior band only folds
// because you asked for it, with `z` or with the chip that hangs off an empty run. Either way the
// strip says what it covers and which way it goes: the whole band is the button, and the mark next
// to its range says Expand. It never has anything to count: an hour with an event in it is not
// folded, whatever fold it sits inside.

import { memo } from "react";
import type { Segment } from "../grid/fit";
import { EXPAND_ICON, FOLD_ICON_SIZE } from "./GridGaps";
import { rangeLabel, vars } from "./GridModel";
import { Icon } from "./Icon";

interface GridStripProps {
  segment: Segment;
  onUnfold: (range: { start: number; end: number }) => void;
}

export const GridStrip = memo(function GridStrip({ segment, onUnfold }: GridStripProps) {
  const range = { start: segment.start / 60, end: segment.end / 60 };
  const label = `Expand ${rangeLabel(range)}`;
  return (
    <button
      type="button"
      className="grid-strip"
      data-no-drag=""
      title={`${label} (z)`}
      aria-label={label}
      style={vars({ top: `${segment.y}px`, height: `${segment.height}px` })}
      onClick={() => onUnfold(range)}
    >
      <span className="grid-strip-range">{rangeLabel(range)}</span>
      <span className="grid-strip-mark">
        <Icon size={FOLD_ICON_SIZE}>{EXPAND_ICON}</Icon>
        <span className="grid-fold-verb">Expand</span>
      </span>
      <span className="grid-strip-rule" />
    </button>
  );
});
