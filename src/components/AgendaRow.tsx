// One line of the agenda: when, what, where, on a surface tinted with its calendar's colour. Same
// rule as a block on the grid, and the same tokens, drawn a shade weaker: a row is several times
// the area of a block, and a fortnight of them at the grid's strength is a stack of highlighter.

import { memo } from "react";
import type { InstanceKey } from "../ipc";
import { calVars, keyOf, vars, eventTitle } from "./GridModel";
import { splitMatch, timeLabel, type AgendaItem } from "./AgendaModel";

interface AgendaRowProps {
  item: AgendaItem;
  selected: boolean;
  /** Lowercased search terms to mark in the summary. Empty in the agenda proper. */
  terms: readonly string[];
  onSelect: (key: InstanceKey) => void;
  onOpen?: (key: InstanceKey) => void;
}

export const AgendaRow = memo(function AgendaRow({
  item,
  selected,
  terms,
  onSelect,
  onOpen,
}: AgendaRowProps) {
  const { instance } = item;
  const summary = eventTitle(instance);

  let hint = summary;
  if (instance.location) hint += ` · ${instance.location}`;
  if (instance.status === "tentative") hint += " · tentative";
  if (instance.pending) hint += " · not pushed yet";

  const parts = terms.length > 0 ? splitMatch(summary, terms) : null;

  return (
    <button
      type="button"
      className="agenda-row"
      tabIndex={-1}
      title={hint}
      data-id={item.id}
      data-allday={instance.allDay || undefined}
      data-status={instance.status}
      data-pending={instance.pending || undefined}
      data-readonly={instance.readOnly || undefined}
      data-selected={selected || undefined}
      style={vars(calVars(instance))}
      onClick={() => onSelect(keyOf(instance))}
      onDoubleClick={() => onOpen?.(keyOf(instance))}
    >
      <span className="agenda-row-time">{timeLabel(item)}</span>
      <span className="agenda-row-text">
        <span className="agenda-row-title">
          {parts
            ? parts.map((part, i) =>
                part.hit ? (
                  <mark key={i} className="agenda-mark">
                    {part.text}
                  </mark>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )
            : summary}
        </span>
        {instance.location && <span className="agenda-row-where">{instance.location}</span>}
      </span>
    </button>
  );
});
