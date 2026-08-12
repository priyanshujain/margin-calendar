// The smallest window the app can be put in. `src-tauri/tauri.conf.json` sets minWidth 880 and
// minHeight 560, so this is not a hypothetical size: it is the corner of the range the product
// ships with, and it is the one nobody looks at.

import { expect, test } from "@playwright/test";
import { gridFit, openApp, settle } from "./app";

const MIN = { width: 880, height: 560 };

test.use({ viewport: MIN });

// FAILING in agenda view, and it is the app, not the test. `.titlebar` is a `1fr auto 1fr` grid
// and `.header-range` is a nowrap button with nothing to trim it, so the agenda's long range
// ("11 August to 9 September 2026") runs out of its column and the view switcher paints over it.
test("the header does not collide with itself in any view", async ({ page }) => {
  await openApp(page);

  for (const key of ["w", "d", "a"] as const) {
    await page.keyboard.press(key);
    await settle(page);

    const measured = await page.evaluate(() => {
      const range = document.querySelector(".header-range")?.getBoundingClientRect();
      const views = document.querySelector(".view-switch")?.getBoundingClientRect();
      const trail = document.querySelector(".trail")?.getBoundingClientRect();
      if (!range || !views || !trail) throw new Error("the header is not on screen");
      return {
        rangeRight: range.right,
        viewsLeft: views.left,
        viewsRight: views.right,
        trailLeft: trail.left,
      };
    });

    // The date range is a nowrap button in a 1fr column, so when it outgrows its share it runs
    // under the view switcher rather than being trimmed.
    expect(measured.rangeRight, `date range overlaps the view switcher in ${key}`).toBeLessThanOrEqual(
      measured.viewsLeft,
    );
    expect(measured.viewsRight).toBeLessThanOrEqual(measured.trailLeft);
  }
});

test("the grid still fits, and still fills the window", async ({ page }) => {
  await openApp(page);
  const fit = await gridFit(page);
  expect(fit.bodyBottom).toBeCloseTo(fit.windowHeight, 0);
  expect(fit.canvasHeight).toBeCloseTo(fit.bodyHeight, 0);
  expect(fit.overflow).toBe(false);
  await expect(page.locator(".grid-head-day")).toHaveCount(7);
  await expect(page.locator(".grid-allday")).toBeVisible();
});

test("no block is painted over by the one after it", async ({ page }) => {
  await openApp(page);

  // A block shorter than the minimum block height is drawn taller than its own time, which is
  // right: it has to stay hittable. It must not be drawn *under* the next block, though, or the
  // title it was given that height for is the thing that gets covered.
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".grid-event")]
      .map((el) => {
        const title = el.querySelector<HTMLElement>(".grid-event-title");
        if (!title) return null;
        const rect = title.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(rect.left + 4),
          Math.round(rect.top + rect.height / 2),
        );
        return hit && el.contains(hit)
          ? null
          : `${(title.textContent ?? "").trim()} (${Math.round(el.getBoundingClientRect().height)}px)`;
      })
      .filter((entry): entry is string => entry !== null),
  );

  expect(covered).toEqual([]);
});

test("the agenda is readable at the smallest size", async ({ page }) => {
  await openApp(page, { view: "agenda" });
  const rows = page.locator(".agenda-row");
  expect(await rows.count()).toBeGreaterThan(5);

  // Nothing spills sideways out of the window.
  const spill = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(spill).toBeLessThanOrEqual(0);
});
