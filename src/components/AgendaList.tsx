// The list itself, shared by the agenda view and by search results, which are the same thing shown
// for a different set of instances.
//
// No virtualisation and no measurement: thirty days is a few hundred rows and the DOM is fine with
// that. The only thing this component does beyond render is keep the selection on screen, because
// the selection moves from the keyboard and the list is the one part of the app that scrolls.

import { useEffect, useRef } from "react";
import type { InstanceKey } from "../ipc";
import { addDays, dayName, monthName, today } from "../time";
import { keyId, keyOf, sameKey } from "./GridModel";
import { AgendaRow } from "./AgendaRow";
import { gapDates, gapLabel, type AgendaSection } from "./AgendaModel";

const NO_TERMS: readonly string[] = [];

interface AgendaListProps {
  sections: readonly AgendaSection[];
  selected: InstanceKey | null;
  onSelect: (key: InstanceKey) => void;
  onOpen?: (key: InstanceKey) => void;
  /** Lowercased search terms to mark in each summary. */
  terms?: readonly string[];
  /** A quiet line above the list: loading, an error, or why there is nothing to show. */
  note?: string | null;
}

export function AgendaList({
  sections,
  selected,
  onSelect,
  onOpen,
  terms = NO_TERMS,
  note,
}: AgendaListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedId = selected ? keyId(selected) : null;
  const todayMs = today();

  useEffect(() => {
    if (!selectedId) return;
    const row = scrollRef.current?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <div className="agenda-scroll" ref={scrollRef}>
      <div className="agenda-inner">
        {note && <p className="agenda-note">{note}</p>}
        {sections.map((section) =>
          section.kind === "gap" ? (
            <div
              key={section.key}
              className="agenda-gap"
              data-past={section.to <= todayMs || undefined}
            >
              <span className="agenda-gap-dates">{gapDates(section)}</span>
              <span className="agenda-gap-rule" />
              <span className="agenda-gap-text">{gapLabel(section)}</span>
            </div>
          ) : (
            <section
              key={section.key}
              className="agenda-day"
              data-today={section.dayStart === todayMs || undefined}
              data-past={addDays(section.dayStart, 1) <= todayMs || undefined}
            >
              <h3 className="agenda-day-head">
                <span className="agenda-day-name">{dayName(section.dayStart)}</span>
                <span className="agenda-day-date">{new Date(section.dayStart).getDate()}</span>
                {section.showMonth && (
                  <span className="agenda-day-month">{monthName(section.dayStart)}</span>
                )}
                <span className="agenda-day-rule" />
                <span className="agenda-day-count">{section.items.length}</span>
              </h3>
              <div className="agenda-rows">
                {section.items.map((item) => (
                  <AgendaRow
                    key={item.id}
                    item={item}
                    terms={terms}
                    selected={sameKey(selected, keyOf(item.instance))}
                    onSelect={onSelect}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </section>
          ),
        )}
      </div>
    </div>
  );
}
