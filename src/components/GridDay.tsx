// One day column. Packing decides the horizontal share, the fit decides the vertical, and neither
// of them knows about the other.

import { memo, useMemo, type PointerEvent as ReactPointerEvent } from "react";
import { timeToY, type FitLayout } from "../grid/fit";
import { packEvents } from "../grid/packing";
import type { InstanceKey } from "../ipc";
import { GridEvent } from "./GridEvent";
import { MIN_BLOCK_H, dayMinutes, keyId, keyOf, sameKey, type Placed } from "./GridModel";
import type { DragMode } from "./GridStore";

interface GridDayProps {
  layout: FitLayout;
  dayStart: number;
  index: number;
  items: readonly Placed[];
  selected: InstanceKey | null;
  dragId: string | null;
  past: boolean;
  today: boolean;
  onPointerDownBlock: (e: ReactPointerEvent, item: Placed, mode: DragMode) => void;
}

export const GridDay = memo(function GridDay({
  layout,
  dayStart,
  index,
  items,
  selected,
  dragId,
  past,
  today,
  onPointerDownBlock,
}: GridDayProps) {
  const packed = useMemo(() => packEvents(items), [items]);

  return (
    <div className="grid-col" data-index={index} data-past={past || undefined} data-today={today || undefined}>
      {packed.map((p) => {
        const { startMin, endMin } = dayMinutes(p.event, dayStart);
        const top = timeToY(layout, startMin);
        const raw = timeToY(layout, endMin) - top;
        // Both ends inside the same strip: it is hiding in there, and the strip carries the count.
        if (raw < 1) return null;
        return (
          <GridEvent
            key={p.event.id}
            item={p.event}
            top={top}
            height={Math.max(raw, MIN_BLOCK_H)}
            left={p.left}
            width={p.width}
            selected={sameKey(selected, keyOf(p.event.instance))}
            dragging={dragId === keyId(keyOf(p.event.instance))}
            onPointerDown={onPointerDownBlock}
          />
        );
      })}
    </div>
  );
});
