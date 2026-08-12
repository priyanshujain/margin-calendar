// Defects found by driving the app at sizes and with pointers nothing else in this suite uses:
// a phone on its side, a tablet, and a window whose safe areas are not zero.
//
// Same rules as the rest of the suite. Nothing reaches into the app, every assertion is something
// the browser laid out, and each test failed before the fix that sits next to it.

import { expect, test, type Page } from "@playwright/test";
import { box, openApp, settle } from "./app";

interface Point {
  x: number;
  y: number;
}

/**
 * A finger, the same way touch.spec.ts makes one: through CDP, because those arrive as real touch
 * events and only those carry `pointerType` `touch` into the handlers that read it.
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

async function swipe(page: Page, from: Point, dx: number): Promise<void> {
  const hand = await finger(page);
  await hand.down(from);
  for (let step = 1; step <= 6; step++) await hand.moveTo({ x: from.x + (dx * step) / 6, y: from.y });
  await hand.up();
  await settle(page);
}

const dates = (page: Page) => page.locator(".grid-head-date").allTextContents();

/**
 * The card's buttons that the chrome has taken over: a tap in the middle of one reaches a bar
 * instead. Anything hidden by the card's own scrolling is the card's business and not this.
 */
function buriedButtons(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".details-card");
    if (!card) throw new Error("no details card is open");
    return [...card.querySelectorAll<HTMLElement>("button")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(rect.left + rect.width / 2),
          Math.round(rect.top + rect.height / 2),
        );
        const chrome = (hit as HTMLElement | null)?.closest(".tabbar, .phonebar");
        return chrome
          ? `${(el.textContent ?? "").trim() || el.getAttribute("aria-label")} is behind the ${chrome.className}`
          : null;
      })
      .filter((entry): entry is string => entry !== null);
  });
}

// A phone on its side. 568x320 is an iPhone SE in landscape, still narrow enough for the phone
// chrome, and the one shape where the two bars leave the least behind.
test.describe("a phone in landscape", () => {
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });

  // The card was placed against the window and painted under the bars, which put Edit, Delete and
  // Close behind the tab bar: not merely covered, unhittable.
  test("the details card stays clear of the tab bar", async ({ page }) => {
    await openApp(page, { view: "day" });

    await page.locator(".grid-event", { hasText: "Design review" }).first().tap();
    await expect(page.locator(".details-card[data-placed]")).toBeVisible();
    await settle(page);

    const card = await box(page.locator(".details-card"));
    const tabs = await box(page.locator(".tabbar"));
    const bar = await box(page.locator(".phonebar"));
    expect(card.bottom).toBeLessThanOrEqual(tabs.top);
    expect(card.top).toBeGreaterThanOrEqual(bar.bottom);

    expect(await buriedButtons(page)).toEqual([]);
  });

  // The card opens where the finger already is, and a touch is followed by a click the finger never
  // asked for. Cancelling the pointerdown stops the mouse events either side of it and not that
  // click, so it landed on whatever the card had just put under the thumb: tapping a meeting opened
  // its editor, and one with a conference link would have opened a browser.
  test("a tap opens the card and nothing else", async ({ page }) => {
    await openApp(page, { view: "day" });

    await page.locator(".grid-event", { hasText: "Design review" }).first().tap();
    await expect(page.locator(".details-card")).toBeVisible();
    await settle(page);

    await expect(page.getByRole("dialog", { name: "Edit event" })).toHaveCount(0);
    await expect(page.locator(".details-card")).toBeVisible();
  });
});

test.describe("a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // The swipe is the way a phone pages the day, and a block you cannot pick up used to swallow it:
  // the block's own handler stopped the press reaching the canvas and then returned. On a day with
  // a couple of meetings marked busy that is most of the column.
  test("a swipe still pages the day when it starts on a read-only block", async ({ page }) => {
    await openApp(page, { view: "day" });
    const before = await dates(page);

    const block = page.locator(".grid-event[data-readonly]").first();
    const rect = await box(block);
    await swipe(page, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, -160);

    expect(await dates(page)).not.toEqual(before);
    // And it paged instead of picking the block up, rather than as well as.
    await expect(page.locator(".grid-ghost")).toHaveCount(0);
    await expect(page.locator(".quick-create")).toHaveCount(0);
  });

  // A read-only block is still a block: the swipe must not have cost it its tap.
  test("tapping a read-only block still opens it", async ({ page }) => {
    await openApp(page, { view: "day" });
    await page.locator(".grid-event[data-readonly]").first().tap();
    await expect(page.locator(".details-card")).toBeVisible();
  });
});

// The desktop header, on the platforms that are not macOS. Both of these are wrong everywhere
// except the one window the header was drawn in, and an iPad is now one of the places it lands.
test.describe("the desktop header off macOS", () => {
  // The 84px lane exists for the macOS traffic lights, which come from `titleBarStyle: "Overlay"`,
  // a macOS-only setting. Everywhere else, Linux and Windows and an iPad and this browser, it was
  // 84px of nothing that pushed the whole row off centre and starved the date range.
  test("there is no lane for traffic lights that do not exist", async ({ page }) => {
    await openApp(page);

    const lead = await box(page.locator(".titlebar .lead"));
    const views = await box(page.locator(".view-switch"));
    const width = page.viewportSize()!.width;

    expect(lead.left).toBeLessThanOrEqual(16);
    // The view switcher is the middle column of the row, so off centre means the row is padded for
    // something that is not there.
    expect(Math.abs((views.left + views.right) / 2 - width / 2)).toBeLessThanOrEqual(2);

    // And the lane is still there for the one window that has traffic lights in it. `main.tsx`
    // writes this attribute on a macOS desktop build and nowhere else.
    await page.evaluate(() => document.documentElement.setAttribute("data-traffic", ""));
    await settle(page);
    expect((await box(page.locator(".titlebar .lead"))).left).toBeGreaterThan(64);
  });

  // `--safe-top` is what the phone bars pad themselves with, and it is not zero on an iPad, which
  // gets this header rather than those bars. The header claimed the top of the screen regardless,
  // which puts its controls under the status bar.
  test("the header clears the safe area above it", async ({ page }) => {
    await openApp(page);
    const before = await box(page.locator(".titlebar"));

    // Written the same way the Android bridge writes it in src/safeArea.ts, which is the one thing
    // that ever sets these at runtime.
    await page.evaluate(() => document.documentElement.style.setProperty("--safe-top", "44px"));
    await settle(page);

    const after = await box(page.locator(".titlebar"));
    expect(after.height).toBeCloseTo(before.height + 44, 0);
    const controls = await page.locator(".titlebar button").all();
    for (const control of controls) {
      const rect = await box(control);
      expect(rect.top).toBeGreaterThanOrEqual(44);
    }
  });
});

// A launch with nothing connected. The fixture ships two accounts, so this state existed and was
// never looked at: an empty grid, which is exactly what a quiet week looks like, and no hint that
// the thing to do is behind a key on the desktop and an overflow sheet on a phone.
test.describe("a first launch", () => {
  // Not `openApp`: it waits for an event to be on screen, and the whole point of this state is that
  // there are none. The seed is otherwise the same.
  const openEmpty = async (page: Page) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("margincal-theme", "light");
      localStorage.setItem("margincal-view", "week");
      localStorage.setItem("margincal-dev-empty", "1");
    });
    await page.goto("/");
  };

  test("the empty calendar says what to do next", async ({ page }) => {
    await openEmpty(page);

    const note = page.locator(".first-run");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Google account");

    // And the way in works from here, rather than only naming the thing.
    await note.getByRole("button", { name: "Connect a Google account" }).click();
    await expect(page.getByRole("dialog", { name: "Google accounts" })).toBeVisible();
  });

  test("it is gone as soon as there is an account", async ({ page }) => {
    await openApp(page);
    await expect(page.locator(".first-run")).toHaveCount(0);
  });
});

// The phone is the tightest thing any of this copy has to fit in, and a button that wraps is the
// tell that a label got longer than the chrome it lives in.
test.describe("account copy on the smallest phone", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

  test("no account control wraps or spills", async ({ page }) => {
    await openApp(page, { view: "day" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator(".menu-item", { hasText: "Google accounts" }).click();

    const panel = page.getByRole("dialog", { name: "Google accounts" });
    await expect(panel).toBeVisible();

    // A `.panel-button` never wraps, so a label that outgrows the sheet does not get taller, it
    // runs out of its row and is clipped by the panel. Judged on the laid-out box against the row
    // it sits in rather than on the length of the string.
    const spilled = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".panel button, .menu-item, .first-run button")]
        .map((el) => {
          const row = el.parentElement?.getBoundingClientRect();
          if (!row) return null;
          const box = el.getBoundingClientRect();
          const past = Math.max(Math.round(box.right - row.right), Math.round(row.left - box.left));
          return past > 1 ? `${(el.textContent ?? "").trim()} runs ${past}px past its row` : null;
        })
        .filter((entry): entry is string => entry !== null),
    );
    expect(spilled).toEqual([]);

    const spill = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(spill).toBeLessThanOrEqual(0);
  });
});
