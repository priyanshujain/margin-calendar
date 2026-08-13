// The keyboard, which is the point of the app.
//
// Each test presses the key a user would press and then asks the screen what happened, rather than
// asking a store what it thinks happened.

import { expect, test } from "@playwright/test";
import {
  MIDDAY,
  axis,
  columnX,
  gridFit,
  gridReady,
  headerDates,
  hourY,
  openApp,
  settle,
} from "./app";

const view = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-view"));

test.describe("navigation", () => {
  test("l moves one day forward and h moves one day back", async ({ page }) => {
    await openApp(page);
    const before = await headerDates(page);
    const range = await page.locator(".header-range").textContent();
    expect(before).toHaveLength(7);

    await page.keyboard.press("l");
    await settle(page);
    const next = await headerDates(page);

    // One day, not a whole week: yesterday's second column is today's first.
    expect(next.slice(0, 6)).toEqual(before.slice(1));
    expect(await page.locator(".header-range").textContent()).not.toBe(range);

    await page.keyboard.press("h");
    await settle(page);
    expect(await headerDates(page)).toEqual(before);
    expect(await page.locator(".header-range").textContent()).toBe(range);
  });

  test("t comes back to today", async ({ page }) => {
    await openApp(page);
    const home = await headerDates(page);

    for (let i = 0; i < 9; i++) await page.keyboard.press("l");
    await settle(page);
    await expect(page.locator(".grid-head-day[data-today]")).toHaveCount(0);

    await page.keyboard.press("t");
    await settle(page);
    expect(await headerDates(page)).toEqual(home);
    // Today is back on screen. It is not necessarily the first column: the week starts on the
    // configured day, so today sits wherever it falls within that week.
    await expect(page.locator(".grid-head-day[data-today]")).toHaveCount(1);
  });
});

test.describe("views", () => {
  test("d, w and a switch view", async ({ page }) => {
    await openApp(page);
    await expect(page.locator(".grid-col")).toHaveCount(7);

    await page.keyboard.press("d");
    await gridReady(page);
    expect(await view(page)).toBe("day");
    await expect(page.locator(".grid-col")).toHaveCount(1);
    await expect(page.locator('.view-option[data-active="true"]')).toHaveText("Day");

    await page.keyboard.press("a");
    await expect(page.locator(".agenda-row").first()).toBeVisible();
    expect(await view(page)).toBe("agenda");
    await expect(page.locator(".grid")).toHaveCount(0);

    await page.keyboard.press("w");
    await gridReady(page);
    expect(await view(page)).toBe("week");
    await expect(page.locator(".grid-col")).toHaveCount(7);
  });

  test("z folds the band under the cursor, and it is still folded after a reload", async ({
    page,
  }) => {
    // Counted strips, so the clock must not be adding one of its own.
    await openApp(page, { now: MIDDAY() });
    const fit = await gridFit(page);
    const evening = await hourY(page, "5pm");
    expect(evening).not.toBeNull();

    await expect(page.locator(".grid-strip")).toHaveCount(2);
    await page.mouse.move(await columnX(page, 3), evening! + fit.rowHeight / 2);
    await page.keyboard.press("z");
    await settle(page);

    // The hour is gone from the axis and a strip stands where it was.
    await expect(page.locator(".grid-strip")).toHaveCount(3);
    expect((await axis(page)).map((entry) => entry.text)).not.toContain("5pm");
    await expect(page.locator(".grid-strip", { hasText: "5pm to 6pm" })).toHaveCount(1);

    await page.reload();
    await gridReady(page);
    await expect(page.locator(".grid-strip", { hasText: "5pm to 6pm" })).toHaveCount(1);
    expect((await axis(page)).map((entry) => entry.text)).not.toContain("5pm");

    // And Shift-Z gives every hour back.
    await page.keyboard.press("Z");
    await settle(page);
    expect((await axis(page)).map((entry) => entry.text)).toContain("5pm");
  });
});

test.describe("summoning", () => {
  test("? opens the shortcut sheet", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    // Generated from the binding table, so the keys it documents are the keys that work.
    await expect(sheet).toContainText("Next day");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("/ opens search and it finds events", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("/");
    const field = page.locator(".agenda-search-input");
    await expect(field).toBeFocused();

    await page.keyboard.type("meetup");
    await expect(page.locator(".agenda-row").first()).toBeVisible();
    await expect(page.locator(".agenda-mark").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
  });

  test("the palette opens on the primary modifier and K", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();

    await page.keyboard.type("agenda");
    await page.keyboard.press("Enter");
    await expect(page.locator(".agenda-row").first()).toBeVisible();
    expect(await view(page)).toBe("agenda");
  });
});

test.describe("keys stand back", () => {
  test("a text field keeps its letters", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("/");
    const field = page.locator(".agenda-search-input");
    await expect(field).toBeFocused();

    // d, w and a are view switches out here and letters in there.
    await page.keyboard.type("dwa");
    await expect(field).toHaveValue("dwa");
    expect(await view(page)).toBe("week");

    await page.keyboard.press("Escape");
    await gridReady(page);
    expect(await view(page)).toBe("week");
  });

  test("the palette is still reachable from inside a text field", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("/");
    await expect(page.locator(".agenda-search-input")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  });

  test("the create input keeps its letters too", async ({ page }) => {
    await openApp(page);
    const fit = await gridFit(page);
    const x = await columnX(page, 1);
    const top = await hourY(page, "5pm");

    await page.mouse.move(x, top! + 3);
    await page.mouse.down();
    await page.mouse.move(x, top! + fit.rowHeight - 3, { steps: 6 });
    await page.mouse.up();
    await settle(page);

    await page.keyboard.type("day away");
    // Not "d" for day view, not "a" for agenda: it is a title.
    expect(await view(page)).toBe("week");
    await page.keyboard.press("Escape");
  });
});
