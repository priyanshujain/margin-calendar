// Day and agenda, which are the two views that are not the week and so are the two nobody looks
// at until they are broken.

import { expect, test } from "@playwright/test";
import { blocks, box, gridFit, openApp } from "./app";

test.describe("day view", () => {
  test("renders one day, full of the day's events, filling the window", async ({ page }) => {
    await openApp(page, { view: "day" });

    await expect(page.locator(".grid-col")).toHaveCount(1);
    await expect(page.locator(".grid-head-day")).toHaveCount(1);
    await expect(page.locator(".grid-allday")).toBeVisible();

    const all = await blocks(page);
    expect(all.length).toBeGreaterThan(3);
    for (const block of all) expect(block.name.trim()).not.toBe("");

    const fit = await gridFit(page);
    expect(fit.canvasHeight).toBeCloseTo(fit.bodyHeight, 0);
    expect(fit.overflow).toBe(false);
  });

  test("one column means wide blocks, not a week's worth of slivers", async ({ page }) => {
    await openApp(page, { view: "day" });
    const column = await box(page.locator('.grid-col[data-index="0"]'));
    const all = await blocks(page);

    // Nothing overlaps three deep all day, so the widest block should be most of the column.
    const widest = Math.max(...all.map((b) => b.width));
    expect(widest).toBeGreaterThan(column.width * 0.6);
  });
});

test.describe("agenda view", () => {
  test("groups by day, in order, with a count that matches the rows", async ({ page }) => {
    await openApp(page, { view: "agenda" });

    const days = page.locator(".agenda-day");
    expect(await days.count()).toBeGreaterThan(5);

    const first = days.first();
    await expect(first.locator(".agenda-day-name")).toHaveText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    const rows = await first.locator(".agenda-row").count();
    expect(rows).toBeGreaterThan(0);
    await expect(first.locator(".agenda-day-count")).toHaveText(String(rows));

    // The dates run forwards.
    const dates = await page.locator(".agenda-day-date").allTextContents();
    expect(dates.length).toBeGreaterThan(5);
    expect(new Set(dates.slice(0, 5)).size).toBe(5);
  });

  test("all-day events are on the list, ahead of the timed ones on their day", async ({ page }) => {
    await openApp(page, { view: "agenda" });

    const trip = page.locator(".agenda-row[data-allday]", { hasText: "Trip to Goa" }).first();
    await expect(trip).toBeVisible();
    await expect(trip.locator(".agenda-row-time")).toHaveText(/all day/i);

    const day = page.locator(".agenda-day").filter({ hasText: "Trip to Goa" }).first();
    const kinds = await day
      .locator(".agenda-row")
      .evaluateAll((rows) => rows.map((row) => row.hasAttribute("data-allday")));
    expect(kinds.indexOf(true)).toBe(0);
    // All-day rows come first and are not interleaved with the timed ones.
    expect(kinds.lastIndexOf(true)).toBeLessThan(kinds.indexOf(false));
  });

  test("the day's rows are in chronological order", async ({ page }) => {
    await openApp(page, { view: "agenda" });
    const times = await page
      .locator(".agenda-day")
      .first()
      .locator(".agenda-row:not([data-allday]) .agenda-row-time")
      .allTextContents();
    expect(times.length).toBeGreaterThan(1);

    const minutes = times.map((text) => {
      const match = text.match(/^(\d+)(?::(\d+))?(am|pm)/i);
      if (!match) return -1;
      const hour = Number(match[1]) % 12 + (/pm/i.test(match[3]) ? 12 : 0);
      return hour * 60 + Number(match[2] ?? 0);
    });
    expect(minutes).not.toContain(-1);
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
  });

  test("the agenda scrolls rather than being cut off at the window", async ({ page }) => {
    await openApp(page, { view: "agenda" });
    const scroller = page.locator(".agenda-scroll");
    const scrolled = await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    // And the window itself still does not scroll.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      ),
    ).toBeLessThanOrEqual(0);
  });
});
