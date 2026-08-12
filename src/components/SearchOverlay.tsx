// AgendaSearch renders its own surface but deliberately not the backdrop, so this layer owns the
// dismissal. Everything else in the app goes through overlayShell's Sheet; search does not,
// because its results panel is wider than `.panel` and has no title bar.
//
// The corpus is `useSearch`, not the view's own instances, so searching is not limited to the
// nine days week view happens to have loaded.

import { useEffect } from "react";
import { useEscapeLayer } from "../escape";
import { useOverlays } from "../store/useOverlays";
import { useSearch } from "../store/useSearch";
import { AgendaSearch } from "./AgendaSearch";
import { useEditor } from "./useEditor";

export function SearchOverlay() {
  const open = useOverlays((s) => s.open) === "search";
  const close = useOverlays((s) => s.close);
  const instances = useSearch((s) => s.instances);
  const phase = useSearch((s) => s.phase);
  useEscapeLayer(open, close);

  useEffect(() => {
    if (open) void useSearch.getState().ensure();
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <AgendaSearch
        instances={phase === "loading" && instances.length === 0 ? undefined : instances}
        onOpen={(key) => useEditor.getState().edit(key)}
      />
    </div>
  );
}

export default SearchOverlay;
