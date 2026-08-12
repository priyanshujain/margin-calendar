// The agenda: thirty days as a flat chronological list, grouped by day, with no time axis at all.
// Nothing here is measured, solved or packed, which is what makes it cheap and what makes it a
// genuinely different view rather than a squashed grid.

import { useMemo } from "react";
import { spanFor, useCalendarView } from "../store/useCalendarView";
import { buildAgenda } from "./AgendaModel";
import { AgendaList } from "./AgendaList";
import { keyId } from "./GridModel";
import { openDetailsFor } from "./useDetails";
import "../styles/agenda.css";

export function AgendaView() {
  const view = useCalendarView((s) => s.view);
  const anchor = useCalendarView((s) => s.anchor);
  const instances = useCalendarView((s) => s.instances);
  const phase = useCalendarView((s) => s.phase);
  const error = useCalendarView((s) => s.error);
  const selected = useCalendarView((s) => s.selected);
  const select = useCalendarView((s) => s.select);

  // The store loads a day of padding either side, so the span is cut back to what it claims.
  const sections = useMemo(() => {
    const { from, to } = spanFor("agenda", anchor);
    return buildAgenda(instances, from, to);
  }, [instances, anchor]);

  if (view !== "agenda") return null;

  const note =
    phase === "error" ? error : phase === "loading" && instances.length === 0 ? "Loading…" : null;

  return (
    <div className="agenda" data-phase={phase}>
      <AgendaList
        sections={sections}
        selected={selected}
        onSelect={select}
        onOpen={(key) => openDetailsFor(key, document.querySelector(`[data-id="${keyId(key)}"]`))}
        note={note}
      />
    </div>
  );
}

export default AgendaView;
