// The grid renders, and it fits.
//
// The whole product rests on two properties: the day you are looking at fills the window without
// scrolling, and the axis does not move under you while you navigate. Both are geometry, so both
// are measured rather than asserted about the DOM.

import { expect, test } from "@playwright/test";
import {
  MIDDAY,
  axis,
  blocks,
  box,
  clockAt,
  columnX,
  gridFit,
  gridReady,
  headerDates,
  hourY,
  openApp,
  settle,
} from "./app";

test.describe("the grid fits the window", () => {
  test("the body is exactly the height the window left it, with nothing to scroll", async ({
    page,
  }) => {
    await openApp(page);
    const fit = await gridFit(page);

    // The body reaches the bottom of the window: no dead band under the last hour.
    expect(fit.bodyBottom).toBeCloseTo(fit.windowHeight, 0);
    // And the day was drawn at exactly that height, which is what "the grid never scrolls" means.
    expect(fit.canvasHeight).toBeCloseTo(fit.bodyHeight, 0);
    expect(fit.bodyScrollHeight).toBeLessThanOrEqual(Math.ceil(fit.bodyHeight) + 1);
    expect(fit.overflow).toBe(false);
    expect(fit.documentScrollHeight).toBeLessThanOrEqual(fit.documentClientHeight);
    // A row solved from a real window is nowhere near the floor the fit gives up at.
    expect(fit.rowHeight).toBeGreaterThan(30);
  });

  test("resizing rescales the day rather than growing a scrollbar", async ({ page }) => {
    await openApp(page);
    const before = await gridFit(page);
    const hoursBefore = (await axis(page)).map((entry) => entry.text);

    await page.setViewportSize({ width: 1440, height: 680 });
    await settle(page);
    const after = await gridFit(page);

    expect(after.bodyBottom).toBeCloseTo(after.windowHeight, 0);
    expect(after.canvasHeight).toBeCloseTo(after.bodyHeight, 0);
    expect(after.overflow).toBe(false);
    // Same hours, less room, so the rows are shorter. Nothing was cut off instead.
    expect(after.rowHeight).toBeLessThan(before.rowHeight);
    expect((await axis(page)).map((entry) => entry.text)).toEqual(hoursBefore);
  });

  test("the day view fills the window too", async ({ page }) => {
    await openApp(page, { view: "day" });
    const fit = await gridFit(page);
    expect(fit.bodyBottom).toBeCloseTo(fit.windowHeight, 0);
    expect(fit.canvasHeight).toBeCloseTo(fit.bodyHeight, 0);
    expect(fit.overflow).toBe(false);
  });

  // FAILING, and it is the app, not the test. `GridView` returns null in the agenda, so the body
  // it measured is thrown away, and the ResizeObserver is installed by a `useLayoutEffect` with an
  // empty dependency list: it never observes the new body. The grid comes back solved for a
  // viewport of zero, sticks at the minimum row height, and no amount of resizing recovers it.
  // Only a reload does.
  test("coming back from the agenda leaves the grid fitted", async ({ page }) => {
    await openApp(page);
    const before = await gridFit(page);

    await page.keyboard.press("a");
    await expect(page.locator(".agenda-row").first()).toBeVisible();
    await page.keyboard.press("w");
    await gridReady(page);

    const after = await gridFit(page);
    expect(after.canvasHeight).toBeCloseTo(after.bodyHeight, 0);
    expect(after.overflow).toBe(false);
    expect(after.rowHeight).toBeCloseTo(before.rowHeight, 0);
  });
});

// Every test here pins the clock to the middle of the working day. The axis takes in the hour it
// is now when the events have left it out, so the shape of a quiet evening is not the shape of a
// busy morning, and an axis test that did not say which one it meant would pass or fail on when it
// was run. What the clock does to the axis is the last test in the file.
test.describe("the axis holds still", () => {
  test("paging a week keeps the same hours on screen", async ({ page }) => {
    await openApp(page, { now: MIDDAY() });
    const before = (await axis(page)).map((entry) => entry.text);
    const dates = await headerDates(page);
    expect(before.length).toBeGreaterThan(6);

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("l");
      await settle(page);
    }

    // The dates moved.
    expect(await headerDates(page)).not.toEqual(dates);
    // The hours did not. The axis itself is the assertion; the header no longer restates it,
    // because the hours it printed were already on screen an inch below.
    expect((await axis(page)).map((entry) => entry.text)).toEqual(before);
  });

  // FAILING, and it is the app, not the test. `GridAllDay` sizes itself from its content, one to
  // three rows, so the band is 84px on a week with all-day events and 32px on a week without. The
  // axis is solved from what the band left over, so paging past them rescales every hour on the
  // grid. The comment at the top of GridAllDay.tsx says the band never does this.
  test("paging a week does not move the hours on screen either", async ({ page }) => {
    await openApp(page, { now: MIDDAY() });
    const before = await axis(page);
    const band = (await box(page.locator(".grid-allday"))).height;
    const row = (await gridFit(page)).rowHeight;

    // Six days on, the fixture's all-day events are behind us. The band has nothing to show, and
    // the axis below it must not notice.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("l");
      await settle(page);
    }

    expect((await box(page.locator(".grid-allday"))).height).toBeCloseTo(band, 0);
    expect((await gridFit(page)).rowHeight).toBeCloseTo(row, 0);
    expect(await axis(page)).toEqual(before);
  });

  test("paging back does not reflow them either", async ({ page }) => {
    await openApp(page, { now: MIDDAY() });
    const before = (await axis(page)).map((entry) => entry.text);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("h");
      await settle(page);
    }
    expect((await axis(page)).map((entry) => entry.text)).toEqual(before);
  });

  test("the empty ends of the day are folded into a strip at each end", async ({ page }) => {
    await openApp(page, { now: MIDDAY() });
    const strips = page.locator(".grid-strip");
    await expect(strips).toHaveCount(2);
    // Midnight to the first event, and the last event to midnight: both say what they cover.
    await expect(strips.first()).toContainText(/12am to \d/);
    await expect(strips.last()).toContainText(/to 12am/);
  });
});

test.describe("folds", () => {
  test("an event created inside a fold takes its hour back and leaves the rest folded", async ({
    page,
  }) => {
    await openApp(page, { now: MIDDAY() });
    // The fixture's last event ends at half six, so the evening is the one empty run long enough
    // to fold and then land an event in. Hold it open first, then fold it by hand.
    await page.locator(".grid-strip", { hasText: /to 12am/ }).click();
    await settle(page);
    const nine = await hourY(page, "9pm");
    expect(nine).not.toBeNull();
    const fit = await gridFit(page);
    await page.mouse.move(await columnX(page, 3), nine! + fit.rowHeight / 2);
    await page.keyboard.press("z");
    await settle(page);
    await expect(page.locator(".grid-strip", { hasText: "7pm to 12am" })).toHaveCount(1);

    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("Yoga 11pm");
    await page.keyboard.press("Enter");
    await settle(page);

    // The hour the event landed in is back on the axis with the event in it at full scale, and
    // the empty hours before it are still folded.
    const yoga = page.locator(".grid-event", { hasText: "Yoga" });
    await expect(yoga).toBeVisible();
    expect((await box(yoga)).height).toBeGreaterThan(fit.rowHeight / 2);
    const hours = (await axis(page)).map((entry) => entry.text);
    expect(hours).toContain("11pm");
    expect(hours).not.toContain("8pm");
    await expect(page.locator(".grid-strip", { hasText: "7pm to 11pm" })).toHaveCount(1);
    await expect(page.locator(".grid-strip", { hasText: "7pm to 12am" })).toHaveCount(0);
  });

  test("a remembered fold over a busy hour shows that hour, and only that hour", async ({
    page,
  }) => {
    // 4pm has a quarter hour block on every workday; 5pm has nothing on any day.
    await openApp(page, {
      now: MIDDAY(),
      storage: { "margincal-folds": '[{"start":16,"end":18}]' },
    });
    const hours = (await axis(page)).map((entry) => entry.text);
    expect(hours).toContain("4pm");
    expect(hours).not.toContain("5pm");
    await expect(page.locator(".grid-strip", { hasText: "5pm to 6pm" })).toHaveCount(1);
    await expect(page.locator(".grid-strip", { hasText: "4pm to 6pm" })).toHaveCount(0);
  });

  test("expanding one strip of a split fold leaves the other where it was", async ({ page }) => {
    // 6pm has a block on every day, so a fold from 5pm to 9pm shows as a strip either side of it,
    // the later one merged into the strip at the end of the day.
    await openApp(page, {
      now: MIDDAY(),
      storage: { "margincal-folds": '[{"start":17,"end":21}]' },
    });
    const five = page.locator(".grid-strip", { hasText: "5pm to 6pm" });
    await expect(five).toHaveCount(1);
    await expect(page.locator(".grid-strip", { hasText: "7pm to 12am" })).toHaveCount(1);

    await five.click();
    await settle(page);
    expect((await axis(page)).map((entry) => entry.text)).toContain("5pm");
    await expect(page.locator(".grid-strip", { hasText: "7pm to 12am" })).toHaveCount(1);
  });
});

test.describe("the hour it is now", () => {
  // Half eleven at night, which the fixture leaves empty: the axis the events drew stops hours
  // earlier, so without the pin there is nowhere for the line to be.
  const LATE = () => clockAt(23, 30);

  test("is on the axis even when the events stopped hours ago", async ({ page }) => {
    await openApp(page, { now: LATE() });

    expect((await axis(page)).map((entry) => entry.text)).toContain("11pm");
    await expect(page.locator(".grid-now")).toHaveCount(1);

    // On today's column, and inside the row it belongs to rather than on the strip above it.
    const line = await box(page.locator(".grid-now"));
    const row = (await gridFit(page)).rowHeight;
    const eleven = (await axis(page)).find((entry) => entry.text === "11pm");
    const canvas = await box(page.locator(".grid-canvas"));
    expect(line.top - canvas.top).toBeGreaterThan(eleven!.y);
    expect(line.top - canvas.top).toBeLessThan(eleven!.y + row);
  });

  test("costs one row, not the whole evening it reached over", async ({ page }) => {
    await openApp(page, { now: LATE() });
    const hours = (await axis(page)).map((entry) => entry.text);

    // The hours between the last event and now are not on the axis; they are in a strip.
    expect(hours).not.toContain("9pm");
    expect(hours).not.toContain("10pm");
    await expect(page.locator(".grid-strip", { hasText: /to 11pm/ })).toHaveCount(1);
    // And the day still fits.
    const fit = await gridFit(page);
    expect(fit.canvasHeight).toBeCloseTo(fit.bodyHeight, 0);
    expect(fit.overflow).toBe(false);
  });

  test("is gone again on a week that does not contain today", async ({ page }) => {
    await openApp(page, { now: LATE() });
    const before = (await axis(page)).map((entry) => entry.text);
    expect(before).toContain("11pm");

    // A whole week on, today is not one of the columns and neither is the hour it is now.
    await page.keyboard.press("L");
    await settle(page);

    expect((await axis(page)).map((entry) => entry.text)).not.toContain("11pm");
    await expect(page.locator(".grid-now")).toHaveCount(0);
  });
});

test.describe("the all-day band", () => {
  test("a multi-day event spans exactly the days it covers", async ({ page }) => {
    await openApp(page);
    const chip = page.locator(".grid-chip", { hasText: "Trip to Goa" });
    await expect(chip).toHaveCount(1);

    // The week starts on the configured day rather than on today, so which columns the trip
    // lands in depends on what day of the week it is. Read them off the header instead of
    // assuming, and clip to the week, since a trip starting on a Saturday runs off the end.
    const days = await page.locator(".grid-head-date").allTextContents();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startCol = days.indexOf(String(tomorrow.getDate()));
    expect(startCol, "the trip starts on a visible day").toBeGreaterThanOrEqual(0);
    const endCol = Math.min(startCol + 3, days.length - 1);

    const first = await box(page.locator(`.grid-col[data-index="${startCol}"]`));
    const last = await box(page.locator(`.grid-col[data-index="${endCol}"]`));
    const rect = await box(chip);
    expect(rect.left).toBeGreaterThanOrEqual(first.left - 4);
    expect(rect.left).toBeLessThan(first.right);
    expect(rect.right).toBeGreaterThan(last.left);
    expect(rect.right).toBeLessThanOrEqual(last.right + 4);
  });

  test("the band never eats the axis: what does not fit hides behind a count", async ({ page }) => {
    await openApp(page);
    const band = await box(page.locator(".grid-allday"));
    const more = page.locator(".grid-chip-more");
    await expect(more).toHaveCount(1);

    const fitBefore = await gridFit(page);
    await more.click();
    await settle(page);

    // Expanding shows the rest without pushing the axis around underneath it.
    await expect(page.locator(".grid-chip", { hasText: "Dentist" })).toBeVisible();
    const fitAfter = await gridFit(page);
    expect(fitAfter.rowHeight).toBeCloseTo(fitBefore.rowHeight, 0);
    expect((await box(page.locator(".grid-allday"))).height).toBeCloseTo(band.height, 0);
  });
});

test.describe("what is on the grid", () => {
  test("today is marked and every column carries the fixture's daily events", async ({ page }) => {
    await openApp(page);
    // Exactly one day is today, and the column under it agrees. Which index that is depends on
    // the day of the week, because the week starts on the configured day, not on today.
    await expect(page.locator(".grid-head-day[data-today]")).toHaveCount(1);
    const marked = await page.locator(".grid-head-day[data-today]").getAttribute("data-index");
    await expect(page.locator(`.grid-col[data-index="${marked}"]`)).toHaveAttribute(
      "data-today",
      "true",
    );

    const all = await blocks(page);
    const columns = new Set(all.map((b) => b.column));
    // Seven columns, all of them populated: the fixture's daily habits are on every one.
    expect([...columns].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(all.length).toBeGreaterThan(30);
  });
});
