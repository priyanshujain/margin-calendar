// What every spec needs: a seeded load of the real app, and the handful of measurements the grid
// has to be judged on.
//
// Nothing here reaches into the app's internals. There is no test id anywhere in `src/`, so these
// helpers read what the browser actually laid out: rectangles, computed styles, rendered text.
// That is deliberate. The bugs this suite exists to catch were all things you could see.

import { expect, type Locator, type Page } from "@playwright/test";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface OpenOptions {
  theme?: "light" | "dark";
  view?: "day" | "week" | "agenda";
  /** Extra localStorage entries, written before the app's first script runs. */
  storage?: Record<string, string>;
}

const SEEDED = "__test-seeded";

/**
 * Loads the app with a known store. The seed is written once per context rather than on every
 * navigation, so a test that reloads to check what survived is not silently reset underneath it.
 */
export async function openApp(page: Page, options: OpenOptions = {}): Promise<void> {
  const seed: Record<string, string> = {
    "margincal-theme": options.theme ?? "light",
    "margincal-view": options.view ?? "week",
    // Both are what a first run gets, pinned so a stray local preference cannot change the shape
    // of the week under a test.
    "margincal-week-mode": "rolling",
    "margincal-week-start": "1",
    ...(options.storage ?? {}),
  };

  await page.addInitScript(
    ({ values, flag }) => {
      try {
        if (localStorage.getItem(flag) === "1") return;
        localStorage.clear();
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        localStorage.setItem(flag, "1");
      } catch {
        /* a context without storage is not a context this app runs in */
      }
    },
    { values: seed, flag: SEEDED },
  );

  await page.goto("/");
  if ((options.view ?? "week") === "agenda") await agendaReady(page);
  else await gridReady(page);
}

/** The grid has laid out and the fixture has arrived. */
export async function gridReady(page: Page): Promise<void> {
  await expect(page.locator(".grid-body")).toBeVisible();
  await expect(page.locator(".grid-event").first()).toBeVisible();
  await settle(page);
}

export async function agendaReady(page: Page): Promise<void> {
  await expect(page.locator(".agenda-row").first()).toBeVisible();
  await settle(page);
}

/** Two frames, which is long enough for a ResizeObserver pass and the render it causes. */
export function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function box(target: Locator): Promise<Box> {
  const rect = await target.boundingBox();
  if (!rect) throw new Error("element has no box");
  return {
    ...rect,
    top: rect.y,
    bottom: rect.y + rect.height,
    left: rect.x,
    right: rect.x + rect.width,
  };
}

export interface GridFit {
  /** Pixels the body was given by the window. */
  bodyHeight: number;
  bodyWidth: number;
  bodyBottom: number;
  /** Pixels the day was drawn in. Equal to the body when the fit did its job. */
  canvasHeight: number;
  bodyScrollHeight: number;
  rowHeight: number;
  overflow: boolean;
  windowHeight: number;
  documentScrollHeight: number;
  documentClientHeight: number;
}

export function gridFit(page: Page): Promise<GridFit> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".grid-body");
    const canvas = document.querySelector<HTMLElement>(".grid-canvas");
    const grid = document.querySelector<HTMLElement>(".grid");
    if (!body || !canvas || !grid) throw new Error("the grid is not on screen");
    const rect = body.getBoundingClientRect();
    return {
      bodyHeight: rect.height,
      bodyWidth: rect.width,
      bodyBottom: rect.bottom,
      canvasHeight: canvas.getBoundingClientRect().height,
      bodyScrollHeight: body.scrollHeight,
      rowHeight: Number.parseFloat(getComputedStyle(grid).getPropertyValue("--row-h")),
      overflow: grid.hasAttribute("data-overflow"),
      windowHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
    };
  });
}

export interface AxisLabel {
  text: string;
  /** Pixels from the top of the canvas, which is what "the axis did not move" means. */
  y: number;
}

/** The hour labels down the gutter, in order, positioned relative to the canvas. */
export function axis(page: Page): Promise<AxisLabel[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".grid-canvas");
    if (!canvas) throw new Error("the grid is not on screen");
    const top = canvas.getBoundingClientRect().top;
    return [...document.querySelectorAll(".grid-gutter-label")].map((el) => ({
      text: (el.textContent ?? "").trim(),
      y: Math.round(el.getBoundingClientRect().top - top),
    }));
  });
}

export interface BlockInfo {
  title: string;
  /** What the block's accessible name comes out as, computed the way a screen reader would. */
  name: string;
  size: string | null;
  column: number;
  width: number;
  height: number;
  top: number;
  /** True when the block's own centre is the thing a click at that point would reach. */
  hittable: boolean;
  /** Rendered lines of the title, from its height over its line height. */
  titleLines: number;
  busy: boolean;
}

/**
 * Every block on the axis, measured. The accessible name is approximated the way the platform
 * computes it for these elements: an explicit label, else the rendered text, else the title
 * attribute. One block is checked against Playwright's real computation in the legibility spec.
 */
export function blocks(page: Page): Promise<BlockInfo[]> {
  return page.evaluate(() => {
    const nameOf = (el: HTMLElement): string => {
      const labelled = el.getAttribute("aria-label");
      if (labelled && labelled.trim()) return labelled.trim();
      const text = (el.innerText ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
      return (el.getAttribute("title") ?? "").trim();
    };

    return [...document.querySelectorAll<HTMLElement>(".grid-event")].map((el) => {
      const rect = el.getBoundingClientRect();
      const column = el.closest<HTMLElement>(".grid-col");
      const title = el.querySelector<HTMLElement>(".grid-event-title");
      const lineHeight = title ? Number.parseFloat(getComputedStyle(title).lineHeight) : 0;
      const hit = document.elementFromPoint(
        Math.round(rect.left + rect.width / 2),
        Math.round(rect.top + rect.height / 2),
      );
      return {
        title: (title?.textContent ?? "").trim(),
        name: nameOf(el),
        size: el.getAttribute("data-size"),
        column: Number(column?.dataset.index ?? -1),
        width: rect.width,
        height: rect.height,
        top: rect.top,
        hittable: hit !== null && (hit === el || el.contains(hit)),
        titleLines:
          title && lineHeight > 0
            ? Math.round(title.getBoundingClientRect().height / lineHeight)
            : 0,
        busy: el.hasAttribute("data-busy"),
      };
    });
  });
}

/** The dates in the day bar, left to right. Paging is judged on these. */
export function headerDates(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".grid-head-date")].map((el) => (el.textContent ?? "").trim()),
  );
}

/**
 * The viewport y of a whole hour's rule, or null when that hour is folded away.
 *
 * Measured off the rule rather than the gutter label, because the label is nudged a pixel for
 * optical alignment and a gesture wants the line the block will actually snap to.
 */
export function hourY(page: Page, label: string): Promise<number | null> {
  return page.evaluate((wanted) => {
    const labels = [...document.querySelectorAll(".grid-gutter-label")];
    const at = labels.findIndex((el) => (el.textContent ?? "").trim() === wanted);
    if (at === -1) return null;
    // One whole-hour rule per label, both laid out top down, so they line up by index.
    const rules = [...document.querySelectorAll(".grid-rule:not([data-half])")];
    const rule = rules[at];
    return rule ? rule.getBoundingClientRect().top : null;
  }, label);
}

/** The centre x of a day column, for a gesture that has to land on a particular day. */
export async function columnX(page: Page, index: number): Promise<number> {
  const column = await box(page.locator(`.grid-col[data-index="${index}"]`));
  return column.left + column.width / 2;
}

export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Enough intermediate moves to pass the slop that separates a drag from a click, and to look
  // like a hand rather than a teleport.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);
}

/** The open dialog's accessible name, or null. Every overlay in the app is one. */
export async function openDialog(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? dialog.getAttribute("aria-label") : null;
  });
}

export interface Contrast {
  ratio: number;
  text: string;
  background: string;
}

/**
 * Contrast of a piece of text against whatever is actually behind it, compositing every
 * translucent layer between the element and the page. Event surfaces are washes over paper, so
 * reading one background-color would measure the wrong thing.
 */
export function contrastOf(page: Page, selector: string): Promise<Contrast | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;

    // Resolved through a canvas rather than by reading the string, so any colour space works.
    // getComputedStyle hands back whatever syntax the author wrote, and `oklch()` or
    // `color-mix()` used to fall through the rgb regex as transparent, which reported a
    // perfectly readable block as 1:1 and failed for the wrong reason.
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;

    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (match) {
        const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      }
      if (!value || value === "transparent" || value === "none") return [0, 0, 0, 0];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };

    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
    ];

    const layers: [number, number, number, number][] = [];
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      layers.push(parse(getComputedStyle(node).backgroundColor));
    }
    let background: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) background = over(layers[i], background);

    const text = over(parse(getComputedStyle(el).color), background);

    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb: [number, number, number]) =>
      0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

    const a = luminance(text);
    const b = luminance(background);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const show = (rgb: [number, number, number]) => rgb.map((n) => Math.round(n)).join(",");
    return { ratio: Math.round(ratio * 100) / 100, text: show(text), background: show(background) };
  }, selector);
}

/** The title of the longest-named block, which is the one that stresses a narrow column. */
export const LONG_TITLE =
  "Antithesis x Bengaluru Systems Meetup: deterministic simulation testing in practice";
