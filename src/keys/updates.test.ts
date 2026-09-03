// The one path where the updater must stand down: a package manager owns the binary, so a newer
// version is announced and never installed over it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  notify: vi.fn(),
  call: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("../store/useToast", () => ({ notify: mocks.notify }));
vi.mock("../ipc", () => ({ isDesktop: true, call: mocks.call }));

import { checkForUpdates } from "./updates";

const downloadAndInstall = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.check.mockResolvedValue({ version: "0.0.5", downloadAndInstall });
});

describe("checkForUpdates", () => {
  it("installs and relaunches when the app owns its own binary", async () => {
    mocks.call.mockResolvedValue(null);
    await checkForUpdates();
    expect(downloadAndInstall).toHaveBeenCalled();
    expect(mocks.relaunch).toHaveBeenCalled();
  });

  it("points at the package manager instead of installing over it", async () => {
    mocks.call.mockResolvedValue("nix");
    await checkForUpdates();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(
      "0.0.5 is out. Update with: nix profile upgrade margin-calendar",
    );
  });

  it("does not ask who owns the install when there is nothing newer", async () => {
    mocks.check.mockResolvedValue(null);
    await checkForUpdates();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith("Margin Calendar is up to date");
  });
});
