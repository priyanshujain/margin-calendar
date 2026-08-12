// The block under the pointer during a drag. It is the only thing that repaints while you drag,
// which is why the drag lives in the store rather than in `GridView`'s render.

import { timeToY } from "../grid/fit";
import { formatTime } from "../time";
import { MIN_BLOCK_H, minutesToMs, vars } from "./GridModel";
import { useGrid } from "./GridStore";

export function GridGhost() {
  const drag = useGrid((s) => s.drag);
  const layout = useGrid((s) => s.layout);
  const days = useGrid((s) => s.days);

  if (!drag || !drag.moved || !layout) return null;
  const dayStart = days[drag.dayIndex];
  if (dayStart === undefined) return null;

  const top = timeToY(layout, drag.startMin);
  const height = Math.max(MIN_BLOCK_H, timeToY(layout, drag.endMin) - top);

  return (
    <div
      className="grid-ghost"
      data-mode={drag.mode}
      style={vars({ "--i": drag.dayIndex, top: `${top}px`, height: `${height}px` })}
    >
      <span className="grid-ghost-time">
        {formatTime(minutesToMs(dayStart, drag.startMin))} to{" "}
        {formatTime(minutesToMs(dayStart, drag.endMin))}
      </span>
    </div>
  );
}
