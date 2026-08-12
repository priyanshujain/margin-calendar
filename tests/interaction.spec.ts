// Clicking, dragging, creating, moving, resizing. The gestures the calendar is for.
//
// Every assertion here is about what came back on screen: a card naming the event you clicked, a
// block at the time you dragged out, a block that ended up an hour higher than it started.

import { expect, test, type Page } from "@playwright/test";
import { blocks, box, columnX, drag, gridFit, hourY, openApp, settle } from "./app";

/** Sub-pixel layout and a one pixel optical nudge on the gutter labels. */
const PIXEL_SLACK = 3;

const activeTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? null);

/** A block in a named column, which is how a title that repeats every day is addressed. */
const blockIn = (page: Page, column: number, title: string) =>
  page.locator(`.grid-col[data-index="${column}"] .grid-event`, { hasText: title });

function near(actual: number, expected: number, slack = PIXEL_SLACK): void {
  expect(
    Math.abs(actual - expected),
    `expected ${actual.toFixed(1)} to be within ${slack}px of ${expected.toFixed(1)}`,
  ).toBeLessThanOrEqual(slack);
}

test.describe("opening an event", () => {
  test("clicking a block opens its details, and Escape closes them", async ({ page }) => {
    await openApp(page);
    const title = "Design review with the platform team";
    const block = page.locator(".grid-event", { hasText: title }).first();
    await block.click();

    // The card is whatever the app puts on screen for it; what matters is that it is a dialog,
    // that it names the event, and that it is not the block itself.
    const card = page.getByRole("dialog");
    await expect(card).toBeVisible();
    await expect(card).toContainText(title);

    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  });

  test("clicking a block selects it", async ({ page }) => {
    await openApp(page);
    const block = page.locator(".grid-event", { hasText: "Apply to 1 job" }).first();
    await block.click();
    await expect(block).toHaveAttribute("data-selected", "true");
  });
});

test.describe("creating by dragging", () => {
  test("dragging empty grid, typing a title and pressing Enter creates it there", async ({
    page,
  }) => {
    await openApp(page);
    const fit = await gridFit(page);
    const column = 3;
    const x = await columnX(page, column);
    const top = await hourY(page, "5pm");
    expect(top).not.toBeNull();

    await drag(page, { x, y: top! + 3 }, { x, y: top! + fit.rowHeight - 3 });

    // The create card takes the keyboard the moment it appears.
    expect(await activeTag(page)).toBe("INPUT");
    await page.keyboard.type("Coffee with Ana");
    await page.keyboard.press("Enter");

    const created = blockIn(page, column, "Coffee with Ana");
    await expect(created).toHaveCount(1);

    // On the day it was dragged on, at the hour it was dragged over, an hour long.
    const rect = await box(created);
    near(rect.top, top!);
    near(rect.height, fit.rowHeight);

    // And nowhere else.
    await expect(page.locator(".grid-event", { hasText: "Coffee with Ana" })).toHaveCount(1);
  });

  test("Escape cancels the drag without creating anything", async ({ page }) => {
    await openApp(page);
    const before = (await blocks(page)).length;
    const fit = await gridFit(page);
    const x = await columnX(page, 2);
    const top = await hourY(page, "5pm");

    await drag(page, { x, y: top! + 3 }, { x, y: top! + fit.rowHeight - 3 });
    expect(await activeTag(page)).toBe("INPUT");

    await page.keyboard.press("Escape");
    await settle(page);

    expect(await activeTag(page)).not.toBe("INPUT");
    expect((await blocks(page)).length).toBe(before);
  });
});

test.describe("moving and resizing", () => {
  test("the preview follows the pointer to the time it will land at", async ({ page }) => {
    await openApp(page);
    const fit = await gridFit(page);
    const block = blockIn(page, 4, "Apply to 1 job");
    const before = await box(block);
    const fivePm = await hourY(page, "5pm");
    const x = before.left + before.width / 2;
    const y = before.top + before.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 12, { steps: 4 });
    await page.mouse.move(x, y - fit.rowHeight, { steps: 6 });

    // Half past six moved up an hour is half past five, and the preview says so in words as well
    // as in pixels.
    const ghost = page.locator(".grid-ghost");
    await expect(ghost).toBeVisible();
    await expect(ghost).toContainText("5pm to 5:30pm");
    near((await box(ghost)).top, fivePm!);

    await page.mouse.up();
  });

  test("dragging a block moves it to the time you dropped it at", async ({ page }) => {
    await openApp(page);
    const fit = await gridFit(page);
    const column = 4;
    const before = await box(blockIn(page, column, "Apply to 1 job"));

    // Straight up by one hour: half six becomes half five, on the same day.
    await drag(
      page,
      { x: before.left + before.width / 2, y: before.top + before.height / 2 },
      { x: before.left + before.width / 2, y: before.top + before.height / 2 - fit.rowHeight },
    );

    const after = await box(blockIn(page, column, "Apply to 1 job"));
    near(after.top, before.top - fit.rowHeight);
    near(after.height, before.height);
    // Still one of it, still on the same day.
    await expect(blockIn(page, column, "Apply to 1 job")).toHaveCount(1);
  });

  test("dragging a block onto another day moves it there", async ({ page }) => {
    await openApp(page);
    const from = 4;
    const to = 5;
    const before = await box(blockIn(page, from, "Apply to 1 job"));
    const target = await columnX(page, to);

    await drag(
      page,
      { x: before.left + before.width / 2, y: before.top + before.height / 2 },
      { x: target, y: before.top + before.height / 2 },
    );

    // The day it left has one fewer, the day it landed on has two.
    await expect(blockIn(page, from, "Apply to 1 job")).toHaveCount(0);
    await expect(blockIn(page, to, "Apply to 1 job")).toHaveCount(2);
  });

  test("dragging the bottom edge previews the new end", async ({ page }) => {
    await openApp(page);
    const fit = await gridFit(page);
    const before = await box(blockIn(page, 4, "Apply to 1 job"));
    const x = before.left + before.width / 2;

    await page.mouse.move(x, before.bottom - 2);
    await page.mouse.down();
    await page.mouse.move(x, before.bottom + 10, { steps: 4 });
    await page.mouse.move(x, before.bottom + fit.rowHeight / 2, { steps: 6 });

    const ghost = page.locator(".grid-ghost");
    await expect(ghost).toContainText("6pm to 7pm");
    near((await box(ghost)).top, before.top);
    near((await box(ghost)).height, before.height + fit.rowHeight / 2);

    await page.mouse.up();
  });

  test("dragging the bottom edge resizes it", async ({ page }) => {
    await openApp(page);
    const fit = await gridFit(page);
    const column = 4;
    const before = await box(blockIn(page, column, "Apply to 1 job"));
    const x = before.left + before.width / 2;

    // Half an hour longer, which keeps it inside the hours the axis is already showing.
    await drag(page, { x, y: before.bottom - 2 }, { x, y: before.bottom + fit.rowHeight / 2 });

    const after = await box(blockIn(page, column, "Apply to 1 job"));
    near(after.top, before.top);
    near(after.height, before.height + fit.rowHeight / 2);
  });
});
