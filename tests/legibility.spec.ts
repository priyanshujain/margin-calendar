// Can you read it, and can you hit it.
//
// Every bug that shipped was in here: blocks that said "Untitled", five minute events that were
// unreadable slivers, a long title broken into a column of one-word fragments. None of them was a
// crash and none of them was catchable without rendering the thing.

import { expect, test } from "@playwright/test";
import { LONG_TITLE, blocks, contrastOf, openApp } from "./app";

/** Below this a block is a rule rather than an event, whatever the fit decided. */
const MIN_BLOCK_H = 10;

/** Wider than a three-deep overlap column, so this is the width at which wrapping is a choice. */
const NARROW = 140;

/** More than this and a narrow title has become a column of fragments. */
const MAX_LINES = 3;

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test("no block anywhere says Untitled", async ({ page }) => {
      await openApp(page, { theme });
      const all = await blocks(page);
      const untitled = all.filter((b) => /untitled/i.test(`${b.name} ${b.title}`));
      expect(untitled.map((b) => b.name)).toEqual([]);

      // Not in the all-day band either, and not hiding in a tooltip.
      await expect(page.locator(".grid").getByText("Untitled", { exact: false })).toHaveCount(0);
      await expect(page.locator('.grid [title*="Untitled" i]')).toHaveCount(0);
    });

    test("every block has a non-empty accessible name", async ({ page }) => {
      await openApp(page, { theme });
      const all = await blocks(page);
      expect(all.length).toBeGreaterThan(20);

      const nameless = all.filter((b) => b.name.trim() === "");
      expect(
        nameless.map((b) => `${b.size} block, ${Math.round(b.height)}px, column ${b.column}`),
      ).toEqual([]);

      // One block checked against the platform's own name computation, so the cheap approximation
      // the rest of the suite uses cannot quietly drift away from it.
      await expect(page.locator(".grid-event").first()).toHaveAccessibleName(/\S/);
    });

    test("the shortest events are still blocks you can read and hit", async ({ page }) => {
      await openApp(page, { theme });
      const all = await blocks(page);

      // The fixture's five and ten minute events, which is where slivers came from.
      const meds = all.filter((b) => b.name.includes("Meds"));
      const standup = all.filter((b) => b.name.includes("Stand-up"));
      expect(meds.length).toBeGreaterThan(0);
      expect(standup.length).toBeGreaterThan(0);

      const tooThin = all.filter((b) => b.height < MIN_BLOCK_H);
      expect(tooThin.map((b) => `${b.name} at ${Math.round(b.height)}px`)).toEqual([]);

      const unhittable = all.filter((b) => !b.hittable);
      expect(unhittable.map((b) => `${b.name} in column ${b.column}`)).toEqual([]);
    });

    test("a title in a narrow column is ellipsized, not stacked one word per line", async ({
      page,
    }) => {
      await openApp(page, { theme });
      const all = await blocks(page);

      // The fixture's very long title only ever lands in a three-deep overlap.
      const long = all.filter((b) => b.name.includes("Antithesis"));
      expect(long.length).toBeGreaterThan(0);
      expect(Math.min(...long.map((b) => b.width))).toBeLessThan(NARROW);

      const stacked = all
        .filter((b) => b.width < NARROW && b.titleLines > MAX_LINES)
        .map((b) => `${b.name} wrapped to ${b.titleLines} lines in ${Math.round(b.width)}px`);
      expect(stacked).toEqual([]);
    });

    test("a free/busy block says what it is rather than nothing at all", async ({ page }) => {
      await openApp(page, { theme });
      const all = await blocks(page);
      // 90% of the real account came back with no summary. Those blocks still have to say
      // something, and it must not be the empty string.
      const busy = all.filter((b) => b.busy);
      expect(busy.length).toBeGreaterThan(0);
      for (const block of busy) expect(block.name.trim()).not.toBe("");
    });

    test("block text has enough contrast to read", async ({ page }) => {
      await openApp(page, { theme });
      for (const selector of [".grid-event-title", ".grid-event-time", ".grid-head-name"]) {
        const measured = await contrastOf(page, selector);
        expect(measured, selector).not.toBeNull();
        expect(measured!.ratio, `${selector} is ${measured!.ratio}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("the quiet layer of type is still type", async ({ page }) => {
      await openApp(page, { theme });

      // The hours down the gutter, the folded strips and the band's label are all deliberately
      // quiet. Small text wants 4.5:1 to meet AA; this holds them to 3, which is the floor for
      // text of any size at all, so a failure here is not a matter of taste.
      const quiet = [
        ".grid-gutter-label",
        ".grid-strip-range",
        ".grid-allday-gutter",
        ".grid-chip-more",
      ];

      const failures: string[] = [];
      for (const selector of quiet) {
        const measured = await contrastOf(page, selector);
        expect(measured, selector).not.toBeNull();
        if (measured!.ratio < 3) {
          failures.push(
            `${selector}: ${measured!.ratio}:1 (${measured!.text} on ${measured!.background})`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  });
}

test("the long title is shown in full somewhere it has room", async ({ page }) => {
  // The grid is allowed to cut it. The agenda, which has a whole line, is not.
  await openApp(page, { view: "agenda" });
  await expect(page.locator(".agenda-row-title", { hasText: "Antithesis" }).first()).toHaveText(
    LONG_TITLE,
  );
});

test("the agenda does not say Untitled either", async ({ page }) => {
  await openApp(page, { view: "agenda" });
  await expect(page.locator(".agenda").getByText("Untitled", { exact: false })).toHaveCount(0);
});
