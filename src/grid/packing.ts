// Event packing, the standard constraint model. Sort by start then by length, cut the day into
// collision clusters, give each event the leftmost column that is free where it starts, then let
// it grow rightward across every column that stays free for its whole run.
//
// Colliding events come out the same width, nothing visually overlaps, and an event that only
// clips the edge of a cluster still takes most of the width.
//
// Pure, and unaware of pixels: `left` and `width` are fractions of the day column. Call it once
// per day with that day's timed events. All-day events live in their own band and are not packed.

/** The shape packing needs from an event. `Instance` satisfies it. */
export interface PackEvent {
  startMs: number;
  /** Exclusive. An event ending where another starts does not collide with it. */
  endMs: number;
}

/**
 * A zero-length event still has to be visible, so collisions treat it as a minute long. Without
 * this it would collide with nothing, take the full width and paint straight over its neighbours.
 */
export const MIN_SLOT_MS = 60_000;

export interface Packed<T> {
  event: T;
  /** Index of the collision cluster, in start order. Useful for keys and for debugging. */
  cluster: number;
  column: number;
  /** Columns the event grew across, at least 1. */
  span: number;
  /** Columns in the cluster, so `column`/`span` can be read back as pixels. */
  columns: number;
  /** Fraction of the day column, in `[0, 1]`. `left + width` never exceeds 1. */
  left: number;
  width: number;
}

interface Slot {
  index: number;
  start: number;
  end: number;
}

const overlaps = (a: Slot, b: Slot) => a.start < b.end && b.start < a.end;

export function packEvents<T extends PackEvent>(events: readonly T[]): Packed<T>[] {
  const slots: Slot[] = events.map((e, index) => {
    const start = Number.isFinite(e.startMs) ? e.startMs : 0;
    const end = Number.isFinite(e.endMs) ? e.endMs : start;
    return { index, start, end: Math.max(end, start + MIN_SLOT_MS) };
  });

  slots.sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.index - b.index,
  );

  const packed: Packed<T>[] = [];
  let cluster = 0;
  let members: Slot[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (members.length === 0) return;

    // Leftmost column free at the event's start. A column is free once its last event has ended.
    const columnEnd: number[] = [];
    const columnOf = new Map<number, number>();
    const inColumn: Slot[][] = [];
    for (const s of members) {
      let c = 0;
      while (c < columnEnd.length && columnEnd[c] > s.start) c++;
      if (c === columnEnd.length) {
        columnEnd.push(s.end);
        inColumn.push([s]);
      } else {
        columnEnd[c] = Math.max(columnEnd[c], s.end);
        inColumn[c].push(s);
      }
      columnOf.set(s.index, c);
    }

    const columns = columnEnd.length;
    for (const s of members) {
      const column = columnOf.get(s.index) as number;
      let span = 1;
      while (
        column + span < columns &&
        !inColumn[column + span].some((other) => overlaps(s, other))
      ) {
        span++;
      }
      packed.push({
        event: events[s.index],
        cluster,
        column,
        span,
        columns,
        left: column / columns,
        width: span / columns,
      });
    }

    cluster++;
    members = [];
    clusterEnd = -Infinity;
  };

  for (const s of slots) {
    if (s.start >= clusterEnd) flush();
    members.push(s);
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  flush();

  return packed;
}
