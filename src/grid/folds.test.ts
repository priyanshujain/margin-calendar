import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BOUNDS } from "./fit";
import { loadBounds, loadFolds, saveBounds, saveFolds } from "./folds";

/** A headless run has no window at all, which is also the case this module has to survive. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const localStorage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
  globalThis.window = { localStorage } as unknown as Window & typeof globalThis;
  return data;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("fold storage", () => {
  it("gives empty folds and the default bounds with no storage at all", () => {
    expect(loadFolds()).toEqual([]);
    expect(loadBounds()).toEqual(DEFAULT_BOUNDS);
    expect(() => saveFolds([{ start: 12, end: 14 }])).not.toThrow();
    expect(() => saveBounds({ start: 8, end: 20 })).not.toThrow();
  });

  it("round trips folds, normalized on the way in", () => {
    fakeStorage();
    saveFolds([
      { start: 14, end: 16 },
      { start: 12, end: 14 },
    ]);
    expect(loadFolds()).toEqual([{ start: 12, end: 16 }]);
  });

  it("round trips bounds", () => {
    fakeStorage();
    saveBounds({ start: 7, end: 19 });
    expect(loadBounds()).toEqual({ start: 7, end: 19 });
  });

  it("writes the shape index.html reads before first paint", () => {
    const data = fakeStorage();
    saveFolds([{ start: 12, end: 14 }]);
    saveBounds({ start: 8, end: 20 });
    expect(JSON.parse(data.get("margincal-folds") as string)).toEqual([{ start: 12, end: 14 }]);
    expect(JSON.parse(data.get("margincal-bounds") as string)).toEqual({ start: 8, end: 20 });
  });

  it("ignores anything it did not write", () => {
    fakeStorage({
      "margincal-folds": '{"nope":1}',
      "margincal-bounds": "not json",
    });
    expect(loadFolds()).toEqual([]);
    expect(loadBounds()).toEqual(DEFAULT_BOUNDS);

    fakeStorage({
      "margincal-folds": '[{"start":12,"end":14},null,{"start":"x","end":3}]',
      "margincal-bounds": '{"start":20,"end":8}',
    });
    expect(loadFolds()).toEqual([{ start: 12, end: 14 }]);
    expect(loadBounds()).toEqual(DEFAULT_BOUNDS);
  });
});
