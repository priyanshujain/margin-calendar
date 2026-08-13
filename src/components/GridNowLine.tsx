// The now line, and the wash over the part of today that has already gone. A minute is as fine as
// either needs to be, and this is the only thing on the tick, so the rest of the grid never
// rerenders for it.

import { isFolded, timeToY, type FitLayout } from "../grid/fit";
import { isSameDay, minutesFromMidnight } from "../time";
import { useMinuteTick } from "../useClock";
import { vars } from "./GridModel";

interface GridNowLineProps {
  layout: FitLayout;
  dayStart: number;
  dayIndex: number;
}

export function GridNowLine({ layout, dayStart, dayIndex }: GridNowLineProps) {
  const now = useMinuteTick();
  if (!isSameDay(now, dayStart)) return null;

  const minutes = minutesFromMidnight(now);
  if (isFolded(layout, minutes)) return null;
  const y = timeToY(layout, minutes);

  return (
    <>
      <div className="grid-now-past" style={vars({ "--i": dayIndex, height: `${y}px` })} />
      <div className="grid-now" style={vars({ "--i": dayIndex, top: `${y}px` })} />
    </>
  );
}
