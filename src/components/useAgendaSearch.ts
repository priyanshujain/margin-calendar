// Search query state. It lives next to the components that use it rather than in `src/store/`,
// because nothing outside the agenda has any business reading a half-typed query.
//
// There is no search command in the IPC contract and there will not be one: search filters what
// the view has already loaded.

import { create } from "zustand";

interface AgendaSearchState {
  query: string;
  setQuery: (query: string) => void;
  clear: () => void;
}

export const useAgendaSearch = create<AgendaSearchState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
  clear: () => set((s) => (s.query === "" ? {} : { query: "" })),
}));
