// The now line, and the wash over the part of today that has already gone. A minute is as fine as
// either needs to be, and the tick lives here so the rest of the grid never rerenders for it.

import { useEffect, useState } from "react";
import { isFolded, timeToY, type FitLayout } from "../grid/fit";
import { isSameDay, minutesFromMidnight } from "../time";
import { vars } from "./GridModel";

const MINUTE = 60_000;

/** Rounds up to the next wall-clock minute, so the line moves when the clock does. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, MINUTE - (Date.now() % MINUTE));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

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
