// The phone. 390x844 is an iPhone 15's viewport, and it is the size at which the desktop header
// stops fitting at all: three groups on one row want about 700px.
//
// What is checked here is the chrome, not the grid. The bars have to be there instead of the
// header, they have to reach the views, the overflow has to reach everything that lost its icon,
// and every one of them has to be big enough to hit with a thumb. The panels behind them have to
// come up from the bottom edge rather than float in the middle of a screen this small.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { box, openApp, settle } from "./app";

const PHONE = { width: 390, height: 844 };

// hasTouch as well as the size, because a phone is both and the two are separate switches: the
// layout keys off the width and the target sizes key off the pointer.
test.use({ viewport: PHONE, hasTouch: true });

/** The phone opens on the day, which is what the boot script picks when nothing was ever chosen. */
const openPhone = (page: Page) => openApp(page, { view: "day" });

/** The sheet slides up, so a rectangle read too early is a rectangle from halfway there. */
async function landed(target: Locator): Promise<void> {
  await target.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

const openMenu = async (page: Page) => {
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
};

const spill = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the phone gets two bars instead of the header", async ({ page }) => {
  await openPhone(page);

  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-phone"))).toBe(true);
  await expect(page.locator(".titlebar")).toHaveCount(0);
  await expect(page.locator(".phonebar")).toBeVisible();
  await expect(page.locator(".tabbar")).toBeVisible();

  // The top bar starts at the top and the tab bar ends at the bottom, with the stage between them.
  const top = await box(page.locator(".phonebar"));
  const tabs = await box(page.locator(".tabbar"));
  expect(top.top).toBe(0);
  expect(tabs.bottom).toBeCloseTo(PHONE.height, 0);
  expect(tabs.top).toBeGreaterThan(top.bottom);
  expect(await spill(page)).toBeLessThanOrEqual(0);
});

test("the date range and Today still work from the top bar", async ({ page }) => {
  await openPhone(page);
  const range = page.locator(".phonebar-range");
  const start = await range.textContent();

  await page.getByRole("button", { name: "Next day" }).click();
  await settle(page);
  expect(await range.textContent()).not.toBe(start);

  await page.getByRole("button", { name: "Today" }).click();
  await settle(page);
  expect(await range.textContent()).toBe(start);

  // The range is the way into the month, the same as the header's is.
  await range.click();
  await expect(page.getByRole("dialog", { name: "Jump to" })).toBeVisible();
});

test("the tab bar switches the view", async ({ page }) => {
  await openPhone(page);
  const view = () => page.evaluate(() => document.documentElement.getAttribute("data-view"));

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await settle(page);
  expect(await view()).toBe("week");

  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(page.locator(".agenda-row").first()).toBeVisible();
  expect(await view()).toBe("agenda");
  expect(await spill(page)).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Day", exact: true }).click();
  await settle(page);
  expect(await view()).toBe("day");
  await expect(page.locator(".tabbar-view[data-active='true']")).toHaveText("Day");
});

const ROWS: { label: string; opens: string }[] = [
  { label: "Calendars", opens: "Calendars" },
  { label: "Settings", opens: "Settings" },
  { label: "Accounts", opens: "Accounts" },
  { label: "Keyboard shortcuts", opens: "Keyboard shortcuts" },
];

for (const row of ROWS) {
  test(`the overflow menu opens ${row.opens}`, async ({ page }) => {
    await openPhone(page);
    await openMenu(page);
    await page.locator(".menu-item", { hasText: row.label }).click();

    await expect(page.getByRole("dialog", { name: row.opens })).toBeVisible();
    // One panel at a time: the menu is replaced by what it opened, not stacked under it.
    await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
  });
}

test("the overflow menu reaches search, sync and the theme", async ({ page }) => {
  await openPhone(page);

  await openMenu(page);
  await page.locator(".menu-item", { hasText: "Search events" }).click();
  await expect(page.locator(".agenda-search-input")).toBeVisible();
  await page.keyboard.press("Escape");

  // The theme is the one row that leaves the sheet up, so the second tap is not four taps away.
  await openMenu(page);
  await page.locator(".menu-item", { hasText: "Dark mode" }).click();
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
    "dark",
  );
  await expect(page.locator(".menu-item", { hasText: "Light mode" })).toBeVisible();

  // Anything that acts in place and is done acting closes it.
  await page.locator(".menu-item", { hasText: "Sync now" }).click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
});

test("an overlay is a bottom sheet, not a box in the middle", async ({ page }) => {
  await openPhone(page);
  await openMenu(page);

  const panel = page.locator(".panel");
  await landed(panel);
  const sheet = await box(panel);

  expect(sheet.left).toBe(0);
  expect(sheet.width).toBe(PHONE.width);
  expect(sheet.bottom).toBeCloseTo(PHONE.height, 0);
  // It is a layer over the page, so the page is still visible above it.
  expect(sheet.height).toBeLessThanOrEqual(PHONE.height * 0.88);
  expect(await spill(page)).toBeLessThanOrEqual(0);

  // Square top corners would read as a screen rather than something laid over one.
  const radii = await panel.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.borderTopLeftRadius, style.borderBottomLeftRadius];
  });
  expect(Number.parseFloat(radii[0])).toBeGreaterThan(0);
  expect(Number.parseFloat(radii[1])).toBe(0);
});

test("every control in the chrome is big enough to hit", async ({ page }) => {
  await openPhone(page);
  await openMenu(page);

  // 44px is Apple's floor for a target, and the number the bars are laid out around.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".phonebar button, .tabbar button, .menu-item")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const name = (el.getAttribute("aria-label") ?? el.innerText ?? "").trim();
        return { name, width: Math.round(rect.width), height: Math.round(rect.height) };
      })
      .filter((control) => Math.min(control.width, control.height) < 44),
  );

  expect(small).toEqual([]);
});

// A panel reached from the menu has to lead back to it. The menu dispatches the same commands a
// key does, and a command opens a panel with `show`, which clears the trail, so without
// `reachedFrom` closing Settings here drops you on the grid instead of the sheet you were reading.
// That is the same dead end the desktop had before the back arrow existed.
test("a panel opened from the menu goes back to the menu", async ({ page }) => {
  await openPhone(page);
  await openMenu(page);

  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();

  const back = settings.locator(".panel-back");
  await expect(back).toBeVisible();
  await back.click();

  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  await expect(settings).toHaveCount(0);
});

// Opening the same panel straight from a bar is not a journey, so it must not grow a back arrow
// that would take you somewhere you have never been.
test("a panel opened directly has no back arrow", async ({ page }) => {
  await openPhone(page);

  await page.locator(".phonebar .header-range, .phonebar-range").first().click();
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".panel-back")).toHaveCount(0);
});
