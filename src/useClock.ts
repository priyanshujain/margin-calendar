// The wall clock, at the two granularities anything on the grid cares about: the minute the now
// line moves on, and the hour the fit holds open around it.
//
// Both are read off the clock once a minute rather than counted down to. A timer's deadline is
// measured in time the machine spent awake, so one set for the top of the hour before the lid
// closed is still waiting out the rest of that hour when it opens, however late it is by then.
// Reading once a minute puts a minute on how far behind either can be; the window coming back, as
// a focus or a visibility change, is read as a tick of its own so it is usually less.
//
// They are separate hooks because they are separate rerenders. The minute belongs to the one
// component that draws the line. The hour is read as often but only changes once an hour, and a
// state set to the value it already holds rerenders nothing.

import { useEffect, useState } from "react";

const MINUTE = 60_000;

/** The top of the local hour `ms` falls in. Not `ms - ms % HOUR`: not every zone is on the hour. */
function hourStart(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function useTick<T>(read: (now: number) => T): T {
  const [value, setValue] = useState(() => read(Date.now()));
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(tick, MINUTE - (Date.now() % MINUTE));
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
    // `read` is a module-level function in every caller, so there is nothing to rebind.
  }, [read]);
  return value;
}

const now = (ms: number) => ms;

/** Now, refreshed on every wall-clock minute. */
export function useMinuteTick(): number {
  return useTick(now);
}

/**
 * The top of the hour it is now, read every minute and changed once an hour.
 *
 * Returning the hour rather than the instant is what makes this cheap to depend on: the value is
 * identical for a whole hour, so a memo keyed on it recomputes once, when the answer changed.
 */
export function useHourStart(): number {
  return useTick(hourStart);
}
