// The all-day band. All-day events live here, and so do multi-day timed ones: they genuinely
// occupy midnight, and putting them on the axis would pin it open at both ends for good.
//
// The band is exactly one row tall, always, and everything past that goes behind a count that
// expands as an overlay.
//
// It has to be a constant. The axis below is solved from whatever height is left, so a band that
// grew with its contents would change the row height as you paged, sliding every hour on the grid.
// That kills the positional memory the whole product is built on. A taller reserve would be the
// other sin, an empty band eating vertical space you cannot reclaim, so one row it is.

import { useMemo, useState } from "react";
import type { Instance, InstanceKey } from "../ipc";
import {
  bandItems,
  bandRows,
  calVars,
  eventTitle,
  isBusy,
  isDeclined,
  keyOf,
  sameKey,
  vars,
  type BandItem,
} from "./GridModel";
import { openDetailsFor } from "./useDetails";

/** Grid rows the band reserves. Constant on purpose: see the note above. */
const BAND_ROWS = 1;

interface GridAllDayProps {
  days: readonly number[];
  instances: readonly Instance[];
  selected: InstanceKey | null;
  onSelect: (key: InstanceKey) => void;
}

export function GridAllDay({ days, instances, selected, onSelect }: GridAllDayProps) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => bandRows(bandItems(instances, days)), [instances, days]);

  // Expanding a band that never overflowed would leave a shadow over nothing, and the flag
  // outlives a navigation, so it only counts while there is something to expand.
  const overflowing = rows.length > BAND_ROWS;
  const open = expanded && overflowing;
  const shown = open ? rows : rows.slice(0, BAND_ROWS);
  const hidden = open ? [] : rows.slice(BAND_ROWS);
  const hiddenCount = hidden.reduce((n, row) => n + row.length, 0);

  const chip = (item: BandItem, row: number) => (
    <button
      type="button"
      key={item.id}
      className="grid-chip"
      title={eventTitle(item.instance)}
      data-busy={isBusy(item.instance) || undefined}
      data-declined={isDeclined(item.instance) || undefined}
      data-status={item.instance.status}
      data-pending={item.instance.pending || undefined}
      data-readonly={item.instance.readOnly || undefined}
      data-selected={sameKey(selected, keyOf(item.instance)) || undefined}
      style={vars({
        ...calVars(item.instance),
        gridColumn: `${item.from + 1} / ${item.to + 1}`,
        gridRow: row + 1,
      })}
      onClick={(e) => {
        onSelect(keyOf(item.instance));
        openDetailsFor(keyOf(item.instance), e.currentTarget);
      }}
    >
      {eventTitle(item.instance)}
    </button>
  );

  return (
    <div className="grid-allday" style={vars({ "--rows": BAND_ROWS })}>
      <div className="grid-allday-gutter">all-day</div>
      <div className="grid-allday-wrap">
        <div className="grid-allday-rows" data-expanded={open || undefined}>
          {shown.map((row, r) => row.map((item) => chip(item, r)))}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="grid-chip-more"
              title={`${hiddenCount} more all-day`}
              onClick={() => setExpanded(true)}
            >
              {hiddenCount} more
            </button>
          )}
          {open && (
            <button
              type="button"
              className="grid-chip-less"
              style={vars({ gridColumn: `1 / ${days.length + 1}`, gridRow: rows.length + 1 })}
              onClick={() => setExpanded(false)}
            >
              Less
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
