// The updater, reached only through the `check-updates` command so the menu item and the palette
// row are the same path. Ported from margin's `src/updater.ts`, minus its progress dialog: there
// is no update UI here yet, so the toast carries the whole story.

import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { packagedBy } from "../api/updates";
import { isDesktop } from "../ipc";
import { notify } from "../store/useToast";

let running = false;

/** A package manager owns the binary, so the update is announced and left to it. */
function updateHint(manager: string, version: string): string {
  if (manager === "nix") return `${version} is out. Update with: nix profile upgrade margin-calendar`;
  return `${version} is out. Update it through ${manager}`;
}

export async function checkForUpdates(): Promise<void> {
  if (!isDesktop || running) return;
  running = true;
  try {
    const update = await check();
    if (!update) {
      notify("Margin Calendar is up to date");
      return;
    }
    const manager = await packagedBy();
    if (manager) {
      notify(updateHint(manager, update.version));
      return;
    }
    notify(`Installing ${update.version}…`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    notify(`Could not check for updates: ${e}`);
  } finally {
    running = false;
  }
}
