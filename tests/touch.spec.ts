// The grid with a finger.
//
// Everything here is the same app the other specs drive, in a phone-sized window with touch
// emulation on, which is what makes `(pointer: coarse)` true and the pointer events say `touch`.
// The bugs this file exists to catch are all the same bug: a finger press is ambiguous, and the
// grid used to resolve every one of them as "drag out a new event".
//
// Nothing here reaches into the app either. The assertions are what the browser laid out: whether
// a card came back, which dates the day bar is showing, what scrolls.

import { expect, test, type Page } from "@playwright/test";
import { axis, box, gridFit, gridReady, headerDates, openApp, settle } from "./app";

/**
 * A phone, and the two emulation flags that go with it. `hasTouch` is what makes the touches below
 * arrive as touches; `isMobile` is what makes the media queries agree that this is a phone, so
 * `data-phone` and `data-touch` are on the root before the first paint.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Comfortably past the 350ms the grid waits before a press becomes a drag. */
const HOLD_MS = 600;

/** Comfortably under it. */
const TAP_MS = 70;

interface Point {
  x: number;
  y: number;
}

/**
 * A finger. Playwright's touchscreen only taps, and every gesture below is about what happens
 * between the press and the release, so the touches go through CDP instead: those arrive as real
 * touch events, which is the only way the pointer events they turn into carry `pointerType`
 * `touch`, which is what the grid reads to decide which rules apply.
 */
async function finger(page: Page) {
  const session = await page.context().newCDPSession(page);
  const send = (type: string, points: Point[]) =>
    session.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    });
  return {
    down: (at: Point) => send("touchStart", [at]),
    moveTo: (at: Point) => send("touchMove", [at]),
    up: () => send("touchEnd", []),
  };
}

async function tapAt(page: Page, at: Point, hold = TAP_MS): Promise<void> {
  const hand = await finger(page);
  await hand.down(at);
  await page.waitForTimeout(hold);
  await hand.up();
  await settle(page);
}

async function pressAt(page: Page, at: Point): Promise<void> {
  await tapAt(page, at, HOLD_MS);
}

/** A press that travels sideways, in the steps a hand would take rather than a teleport. */
async function swipe(page: Page, from: Point, dx: number): Promise<void> {
  const hand = await finger(page);
  await hand.down(from);
  for (let step = 1; step <= 6; step++) {
    await hand.moveTo({ x: from.x + (dx * step) / 6, y: from.y });
  }
  await hand.up();
  await settle(page);
}

/**
 * A point on the axis with nothing on it: no block, no strip, no fold chip.
 *
 * The middle of the longest clear run rather than the first clear pixel, because the browser
 * widens a touch to the size of a finger and snaps it to any control within a few pixels of where
 * it landed. A point four pixels under a strip is a point that presses the strip, and a spec that
 * used one would be testing the strip while claiming to test empty grid.
 */
function emptySpot(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".grid-canvas");
    const cols = document.querySelector<HTMLElement>(".grid-cols");
    if (!canvas || !cols) throw new Error("the grid is not on screen");
    const rect = cols.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const bottom = Math.round(rect.bottom);

    let best = { y: 0, length: 0 };
    let run: number | null = null;
    for (let y = Math.round(rect.top); y <= bottom; y++) {
      const clear = y < bottom && document.elementFromPoint(x, y) === canvas;
      if (clear) {
        if (run === null) run = y;
        continue;
      }
      if (run !== null && y - run > best.length) best = { y: run + (y - run) / 2, length: y - run };
      run = null;
    }
    if (best.length < 24) throw new Error("no run of empty grid long enough to press on");
    return { x, y: best.y };
  });
}

const draft = (page: Page) => page.locator(".quick-create");

test.describe("a press is not a drag", () => {
  test("tapping empty grid creates nothing", async ({ page }) => {
    await openApp(page, { view: "day" });
    const spot = await emptySpot(page);

    await tapAt(page, spot);

    // The whole complaint: every tap on the grid used to leave an event behind.
    await expect(draft(page)).toHaveCount(0);
    await expect(page.locator(".grid-ghost")).toHaveCount(0);
  });

  test("holding empty grid opens a draft there", async ({ page }) => {
    await openApp(page, { view: "day" });
    const spot = await emptySpot(page);

    await pressAt(page, spot);

    await expect(draft(page)).toHaveCount(1);
    // And it is ready to be typed into, the same way the mouse drag leaves it.
    expect(await page.evaluate(() => document.activeElement?.tagName ?? null)).toBe("INPUT");
  });

  test("tapping a block opens it, holding one picks it up", async ({ page }) => {
    await openApp(page, { view: "day" });
    const block = page.locator(".grid-event", { hasText: "Design review" }).first();
    const rect = await box(block);
    const at = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    await tapAt(page, at);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The same press held is the other gesture entirely, and the card must stay out of the way of
    // it: the browser sends a click after a touch whatever the touch turned out to be.
    const hand = await finger(page);
    await hand.down(at);
    await page.waitForTimeout(HOLD_MS);
    await expect(page.locator(".grid-ghost")).toBeVisible();
    await hand.up();
    await settle(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a tap that wanders a few pixels is still a tap", async ({ page }) => {
    await openApp(page, { view: "day" });
    const spot = await emptySpot(page);

    // Six pixels of thumb drift, which is under the touch slop and well over the mouse's three.
    const hand = await finger(page);
    await hand.down(spot);
    await hand.moveTo({ x: spot.x + 4, y: spot.y + 6 });
    await page.waitForTimeout(TAP_MS);
    await hand.up();
    await settle(page);

    await expect(draft(page)).toHaveCount(0);
  });
});

test.describe("swiping pages the view", () => {
  test("a swipe moves the day view by exactly one day", async ({ page }) => {
    await openApp(page, { view: "day" });
    const spot = await emptySpot(page);
    const [todayDate, tomorrowDate] = await page.evaluate(() => {
      const d = new Date();
      const next = new Date();
      next.setDate(next.getDate() + 1);
      return [String(d.getDate()), String(next.getDate())];
    });
    expect(await headerDates(page)).toEqual([todayDate]);

    // Far past the threshold on purpose: a long swipe still buys one day, never a week.
    await swipe(page, spot, -240);

    expect(await headerDates(page)).toEqual([tomorrowDate]);
    // And it paged instead of creating, rather than as well as.
    await expect(draft(page)).toHaveCount(0);
  });

  test("swiping back returns to the day it started on", async ({ page }) => {
    await openApp(page, { view: "day" });
    const spot = await emptySpot(page);
    const before = await headerDates(page);

    await swipe(page, spot, -120);
    expect(await headerDates(page)).not.toEqual(before);

    await swipe(page, await emptySpot(page), 120);
    expect(await headerDates(page)).toEqual(before);
  });

  test("a swipe in the week slides it one column, not seven", async ({ page }) => {
    await openApp(page);
    const before = await headerDates(page);
    expect(before).toHaveLength(7);

    await swipe(page, await emptySpot(page), -160);

    const after = await headerDates(page);
    expect(after).toHaveLength(7);
    // Six of the seven days were already on screen, in the same order, one column to the left.
    expect(after.slice(0, 6)).toEqual(before.slice(1));
  });

  test("a short sideways press is neither a swipe nor a create", async ({ page }) => {
    await openApp(page, { view: "day" });
    const before = await headerDates(page);

    // Half the swipe threshold: not enough to page, and it killed the long press on the way.
    await swipe(page, await emptySpot(page), -28);

    expect(await headerDates(page)).toEqual(before);
    await expect(draft(page)).toHaveCount(0);
  });
});

test.describe("what a finger can reach", () => {
  test("the fold chip is on screen without anything to hover it", async ({ page }) => {
    await openApp(page, { view: "day" });

    // There is no pointer to rest on an empty run, so every empty run carries its own chip.
    const chips = page.locator(".grid-gap-fold");
    expect(await chips.count()).toBeGreaterThan(0);
    await expect(chips.first()).toBeVisible();

    // And it does what it says. Judged on the axis rather than on the number of strips: a run that
    // reaches the bounds folds into the strip already there, so folding one does not always leave
    // one more behind. Hours coming off the axis is what folding means either way.
    const before = (await axis(page)).map((entry) => entry.text);
    await chips.first().tap();
    await settle(page);
    const after = (await axis(page)).map((entry) => entry.text);
    expect(after.length).toBeLessThan(before.length);
  });

  test("the strip says what it does without being pointed at", async ({ page }) => {
    await openApp(page, { view: "day" });
    const verb = page.locator(".grid-strip .grid-fold-verb").first();
    await expect(verb).toBeVisible();
    await expect(verb).toHaveText("Expand");
  });

  test("the resize grips are gone rather than being seven pixels of nothing", async ({ page }) => {
    await openApp(page, { view: "day" });
    const grips = page.locator(".grid-event-grip");
    expect(await grips.count()).toBeGreaterThan(0);
    await expect(grips.first()).toBeHidden();
  });

  test("an all-day chip is tall enough to hit", async ({ page }) => {
    await openApp(page);
    const chip = page.locator(".grid-chip").first();
    const rect = await chip.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.height).toBeGreaterThanOrEqual(24);
  });

  test("tapping a day header opens that day", async ({ page }) => {
    await openApp(page);
    const header = page.locator(".grid-head-day").nth(3);
    const date = (await header.locator(".grid-head-date").textContent())?.trim();

    await header.tap();
    await gridReady(page);

    await expect(page.locator(".grid-head-day")).toHaveCount(1);
    expect(await headerDates(page)).toEqual([date]);
  });
});

test.describe("the phone week is still a grid", () => {
  test("the day bar carries one letter and the date", async ({ page }) => {
    await openApp(page);
    const names = await page.locator(".grid-head-name").allTextContents();
    expect(names).toHaveLength(7);
    for (const name of names) expect(name.trim()).toHaveLength(1);
  });

  test("nothing spills sideways at 390 pixels, in either view", async ({ page }) => {
    for (const view of ["week", "day"] as const) {
      await openApp(page, { view });
      const spill = await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(".grid");
        if (!grid) throw new Error("the grid is not on screen");
        return {
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          grid: grid.scrollWidth - grid.clientWidth,
        };
      });
      expect(spill.document, `the document scrolls sideways in the ${view}`).toBeLessThanOrEqual(0);
      expect(spill.grid, `the grid scrolls sideways in the ${view}`).toBeLessThanOrEqual(0);
    }
  });

  test("no block is drawn past the last column", async ({ page }) => {
    // The body clips what hangs off it, so this never reaches the document's scroll width: the
    // only way to see it is to compare each block against the edge it is supposed to stop at.
    for (const view of ["day", "week"] as const) {
      await openApp(page, { view });
      const spilled = await page.evaluate(() => {
        const cols = document.querySelector<HTMLElement>(".grid-cols");
        if (!cols) throw new Error("the grid is not on screen");
        const edge = cols.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>(".grid-event")]
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const past = Math.round(rect.right - edge.right);
            const short = Math.round(edge.left - rect.left);
            const title = (el.querySelector(".grid-event-title")?.textContent ?? "").trim();
            if (past > 1) return `${title} hangs ${past}px past the last column`;
            if (short > 1) return `${title} starts ${short}px before the first column`;
            return null;
          })
          .filter((entry): entry is string => entry !== null);
      });
      expect(spilled, view).toEqual([]);
    }
  });

  test("the day still fits, between the two bars rather than the window", async ({ page }) => {
    for (const view of ["week", "day"] as const) {
      await openApp(page, { view });
      const fit = await gridFit(page);
      expect(fit.canvasHeight, view).toBeCloseTo(fit.bodyHeight, 0);
      expect(fit.bodyScrollHeight, view).toBeLessThanOrEqual(Math.ceil(fit.bodyHeight) + 1);
      expect(fit.overflow, view).toBe(false);

      // The phone took the top and the bottom of the window for its own chrome, so "the day fits"
      // now means it fits what is left. The bars are the other agent's; what is checked here is
      // that the grid solved for the gap between them and did not run under either.
      const top = await box(page.locator(".phonebar"));
      const tabs = await box(page.locator(".tabbar"));
      const grid = await box(page.locator(".grid"));
      expect(grid.top, view).toBeGreaterThanOrEqual(top.bottom - 1);
      expect(grid.bottom, view).toBeLessThanOrEqual(tabs.top + 1);
      expect(fit.bodyBottom, view).toBeLessThanOrEqual(tabs.top + 1);
    }
  });
});
