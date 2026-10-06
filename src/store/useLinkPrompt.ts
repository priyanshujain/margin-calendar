import { create } from "zustand";

interface LinkPromptState {
  url: string | null;
  ask: (url: string) => void;
  dismiss: () => void;
}

export const useLinkPrompt = create<LinkPromptState>((set) => ({
  url: null,
  ask: (url) => set({ url }),
  dismiss: () => set({ url: null }),
}));

export const askToOpen = (url: string) => useLinkPrompt.getState().ask(url);
