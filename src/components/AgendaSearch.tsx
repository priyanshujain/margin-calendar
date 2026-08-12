// Search. Results are an agenda list, which is the whole reason the agenda owns them: a search hit
// is a day, a time and a summary, and that is a row.
//
// It filters the instances the view has already loaded rather than asking the backend, because
// there is no search command in the IPC contract. See the note in `useAgendaSearch`.
//
// This renders its own surface but not the backdrop: drop it inside a `.overlay` and let that
// layer own Escape.

import { useMemo } from "react";
import type { Instance, InstanceKey } from "../ipc";
import { useCalendarView } from "../store/useCalendarView";
import { buildSearch, countItems, queryTerms } from "./AgendaModel";
import { AgendaList } from "./AgendaList";
import { useAgendaSearch } from "./useAgendaSearch";
import "../styles/agenda.css";

interface AgendaSearchProps {
  /** Defaults to whatever the calendar view has loaded. */
  instances?: readonly Instance[];
  onOpen?: (key: InstanceKey) => void;
}

export function AgendaSearch({ instances, onOpen }: AgendaSearchProps) {
  const loaded = useCalendarView((s) => s.instances);
  const selected = useCalendarView((s) => s.selected);
  const select = useCalendarView((s) => s.select);
  const query = useAgendaSearch((s) => s.query);
  const setQuery = useAgendaSearch((s) => s.setQuery);

  const source = instances ?? loaded;
  const terms = useMemo(() => queryTerms(query), [query]);
  const sections = useMemo(() => buildSearch(source, query), [source, query]);
  const hits = countItems(sections);

  const note =
    terms.length === 0
      ? "Type to search the days already loaded."
      : hits === 0
        ? `Nothing matches "${query.trim()}".`
        : null;

  return (
    <div className="agenda agenda-search">
      <div className="agenda-search-field">
        <input
          className="agenda-search-input"
          type="text"
          value={query}
          placeholder="Search events"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setQuery(e.target.value)}
        />
        {hits > 0 && (
          <span className="agenda-search-count">
            {hits} {hits === 1 ? "match" : "matches"}
          </span>
        )}
      </div>
      <AgendaList
        sections={sections}
        selected={selected}
        onSelect={select}
        onOpen={onOpen}
        terms={terms}
        note={note}
      />
    </div>
  );
}

export default AgendaSearch;
