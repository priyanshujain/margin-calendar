// The seam between "something was clicked" and "the details card is on screen".
//
// The grid and the agenda call `open` with the instance key and the on-screen rectangle of the
// thing that was clicked. The details card positions itself against that rectangle. Neither side
// imports the other, which is what lets them be built in parallel.

import { create } from "zustand";
import type { InstanceKey } from "../ipc";

/** Where the clicked block is, in viewport coordinates. A DOMRect satisfies this. */
export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface DetailsState {
  key: InstanceKey | null;
  anchor: AnchorRect | null;
  open: (key: InstanceKey, anchor: AnchorRect) => void;
  close: () => void;
}

export const useDetails = create<DetailsState>((set) => ({
  key: null,
  anchor: null,
  open: (key, anchor) =>
    set({ key, anchor: { top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height } }),
  close: () => set({ key: null, anchor: null }),
}));

/** Imperative form, for a click handler that has an element to measure. */
export function openDetailsFor(key: InstanceKey, element: Element | null): void {
  const rect = element?.getBoundingClientRect();
  useDetails.getState().open(
    key,
    rect ?? { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 },
  );
}
