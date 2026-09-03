// The wall clock, at the two granularities anything on the grid cares about: the minute the now
// line moves on, and the hour the fit holds open around it.
//
// Both schedule off the clock rather than off an interval, so a tab that was asleep and a machine
// that woke up catch up on the next tick instead of drifting further out every hour. A timer is
// still a timer, though: one set before the lid closed can fire long after its wall-clock
// deadline, and a hidden window's timers run late or not at all. So the window coming back, as a
// focus or a visibility change, is read as a tick of its own.
//
// They are separate hooks because they are separate rerenders. The minute belongs to the one
// component that draws the line; putting the fit on that tick would solve the whole axis sixty
// times an hour to answer a question that changes once.

import { useEffect, useState } from "react";

const MINUTE = 60_000;

/** The top of the local hour `ms` falls in. Not `ms - ms % HOUR`: not every zone is on the hour. */
function hourStart(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** The next one. `setMinutes(60)` rolls the date over for us, daylight saving and all. */
function nextHourStart(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(60, 0, 0);
  return d.getTime();
}

function useTick<T>(read: (now: number) => T, next: (now: number) => number): T {
  const [value, setValue] = useState(() => read(Date.now()));
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const now = Date.now();
      timer = window.setTimeout(tick, Math.max(0, next(now) - now));
    };
    const tick = () => {
      window.clearTimeout(timer);
      setValue(read(Date.now()));
      schedule();
    };
    const woke = () => {
      if (document.visibilityState === "visible") tick();
    };
    schedule();
    document.addEventListener("visibilitychange", woke);
    window.addEventListener("focus", woke);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", woke);
      window.removeEventListener("focus", woke);
    };
    // Both callbacks are module-level functions in every caller, so there is nothing to rebind.
  }, [read, next]);
  return value;
}

const now = (ms: number) => ms;
const nextMinute = (ms: number) => ms + MINUTE - (ms % MINUTE);

/** Now, refreshed on every wall-clock minute. */
export function useMinuteTick(): number {
  return useTick(now, nextMinute);
}

/**
 * The top of the hour it is now, refreshed when the clock turns over into the next one.
 *
 * Returning the hour rather than the instant is what makes this cheap to depend on: the value is
 * identical for a whole hour, so a memo keyed on it recomputes once, when the answer changed.
 */
export function useHourStart(): number {
  return useTick(hourStart, nextHourStart);
}
