// The overlays: summoned, then dismissed. Nothing here is resident, so the thing to check is that
// each one arrives, takes the keyboard while it is up, and goes away in the right order.

import { expect, test, type Page } from "@playwright/test";
import { openApp, settle } from "./app";

async function openCalendars(page: Page) {
  await page.locator('button[title="Calendars"]').click();
}

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
}

const PANELS = [
  { name: "Jump to", open: (page: Page) => page.keyboard.press("m"), contains: /Today/ },
  { name: "Calendars", open: openCalendars, contains: /you@example\.com/ },
  { name: "Settings", open: openSettings, contains: /Week view/ },
  {
    name: "Google accounts",
    open: async (page: Page) => {
      await openSettings(page);
      await page.getByRole("button", { name: "Manage" }).click();
    },
    contains: /Connect a Google account/,
  },
];

for (const panel of PANELS) {
  test(`${panel.name} opens and closes on Escape`, async ({ page }) => {
    await openApp(page);
    await panel.open(page);

    const dialog = page.getByRole("dialog", { name: panel.name });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(panel.contains);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // The grid is still there underneath, and still fitted.
    await expect(page.locator(".grid-event").first()).toBeVisible();
  });

  test(`${panel.name} takes the keyboard while it is open`, async ({ page }) => {
    await openApp(page);
    await panel.open(page);
    await expect(page.getByRole("dialog", { name: panel.name })).toBeVisible();

    // `d` is day view out there. In here it belongs to the panel, which does nothing with it.
    await page.keyboard.press("d");
    await settle(page);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-view"))).toBe(
      "week",
    );
    await expect(page.getByRole("dialog", { name: panel.name })).toBeVisible();
  });
}

test("clicking the backdrop dismisses a panel", async ({ page }) => {
  await openApp(page);
  await openCalendars(page);
  const dialog = page.getByRole("dialog", { name: "Calendars" });
  await expect(dialog).toBeVisible();

  await page.mouse.click(30, 500);
  await expect(dialog).toHaveCount(0);
});

test("Escape unwinds one layer at a time", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Manage" }).click();

  const accounts = page.getByRole("dialog", { name: "Google accounts" });
  await expect(accounts).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).first().click();
  const confirm = page.locator(".confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Disconnect you@example.com?");

  // The confirmation goes first, and the panel it belongs to is still there behind it.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(accounts).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect" }).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(accounts).toHaveCount(0);
});

test("the mini month jumps the view to the day you pick", async ({ page }) => {
  await openApp(page);
  const range = await page.locator(".header-range").textContent();

  await page.keyboard.press("m");
  await expect(page.getByRole("dialog", { name: "Jump to" })).toBeVisible();
  // A day in the same month that is not the one already showing.
  await page.locator(".mini-day:not([data-outside]):not([data-span])").last().click();

  await expect(page.getByRole("dialog", { name: "Jump to" })).toHaveCount(0);
  expect(await page.locator(".header-range").textContent()).not.toBe(range);
  await expect(page.locator(".grid-event").first()).toBeVisible();
});

test("turning a calendar off takes its events off the grid", async ({ page }) => {
  await openApp(page);
  const meetup = page.locator(".grid-event", { hasText: "Antithesis" });
  expect(await meetup.count()).toBeGreaterThan(0);

  await openCalendars(page);
  await page
    .locator(".cal-row", { hasText: "Antithesis x Bengaluru Systems Meetup" })
    .locator("input[type=checkbox]")
    .uncheck();
  await page.keyboard.press("Escape");

  await expect(meetup).toHaveCount(0);
});

test("the theme switch actually repaints", async ({ page }) => {
  await openApp(page);
  const paper = () =>
    page.evaluate(() => getComputedStyle(document.querySelector(".grid")!).backgroundColor);
  const light = await paper();

  await openSettings(page);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await settle(page);

  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
    "dark",
  );
  expect(await paper()).not.toBe(light);
});
