// The disk side of the fit: folds and the last adopted bounds survive a restart, so the axis you
// left is the axis you come back to. `fit.ts` stays pure and takes both as arguments.
//
// Both keys are read before first paint by the blocking IIFE in index.html, which writes
// --bound-start, --bound-end and --fold-count. Changing a shape here means changing it there.

import { DEFAULT_BOUNDS, normalizeFolds, type Bounds, type Fold } from "./fit";

const FOLDS_KEY = "margincal-folds";
const BOUNDS_KEY = "margincal-bounds";

// Read off `window` rather than the bare global: a headless run has neither, and Node's own
// localStorage stub warns the moment you look at it.
function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRange(value: unknown): value is Bounds {
  const r = value as Bounds | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.start === "number" &&
    typeof r.end === "number" &&
    Number.isFinite(r.start) &&
    Number.isFinite(r.end)
  );
}

function read(key: string): unknown {
  const s = store();
  if (!s) return null;
  try {
    return JSON.parse(s.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    // A full or disabled store costs the memory of a fold, not the session.
  }
}

function setVar(name: string, value: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(name, value);
}

export function loadFolds(): Fold[] {
  const raw = read(FOLDS_KEY);
  if (!Array.isArray(raw)) return [];
  return normalizeFolds(raw.filter(isRange));
}

export function saveFolds(folds: readonly Fold[]): Fold[] {
  const clean = normalizeFolds(folds);
  write(FOLDS_KEY, clean);
  setVar("--fold-count", String(clean.length));
  return clean;
}

export function loadBounds(): Bounds {
  const raw = read(BOUNDS_KEY);
  if (!isRange(raw) || raw.end <= raw.start) return DEFAULT_BOUNDS;
  return { start: raw.start, end: raw.end };
}

export function saveBounds(bounds: Bounds): void {
  write(BOUNDS_KEY, bounds);
  setVar("--bound-start", String(bounds.start));
  setVar("--bound-end", String(bounds.end));
}
