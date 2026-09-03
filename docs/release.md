# Releasing

## Installing locally

`just install` builds the app for whatever machine you are sitting at and puts it where that
machine expects to find applications: `/Applications` on macOS, or the package manager on Linux.
It is the same command whether or not the app is already installed, so it doubles as the update.
On macOS it asks a running copy to quit first, because replacing a bundle under a live process
leaves it half old and half new, and starts the new one once it is in place, so the copy on screen
is never older than the copy installed. `just uninstall` reverses it and leaves the data directory
alone.

The local build skips the dmg and builds only the `.app`, since nothing about copying a bundle
into place needs a disk image and building one is the slowest part of a mac bundle. That makes a
locally installed app slightly different from a released one, in that it is ad-hoc signed and has
no updater artifacts. It will not update itself. Rerun `just install`.

## Cutting a release

Releases are manual: run the **Release** workflow from the Actions tab. Leave the version empty to
bump the patch number, or give one to set it. The workflow bumps `tauri.conf.json`, `package.json`
and `Cargo.toml` together, commits that to main, tags it, and builds the tag rather than whatever
main happens to be by then.

It builds a universal macOS bundle and an x86_64 Linux one, and it publishes nothing until both
have landed. The last job downloads `latest.json` and refuses to take the release out of draft
unless `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64` are all in it. A half-populated
manifest is worse than no release: the updater would offer an update to the platforms that made it
and error on the ones that did not.

Linux builds on Ubuntu 22.04 on purpose. The bundle will not run on anything older than the glibc
it was linked against, and 22.04 is the baseline [setup.md](setup.md) commits to.

Windows is not built. The bundle targets in `tauri.conf.json` are the mac and Linux ones, and the
app has never claimed Windows. Adding it is a runner in the build matrix and `msi`/`nsis` in the
targets, at which point the publish gate wants `windows-x86_64` too.

Phones do not come from this pipeline at all. The store is their update channel, and what building
for one takes is in [mobile.md](mobile.md).

## Linux

Linux installs come from Nix rather than from the AppImage. The AppImage bundles Ubuntu's GTK
stack, and a bundled `libwayland-client` cannot talk to a current compositor, so on Hyprland it
silently falls back to Xwayland. The Nix package relinks the published `.deb` against nixpkgs' own
`webkit2gtk-4.1` and runs as a native Wayland client.

Installing, and later updating:

```
nix profile install github:priyanshujain/margin-calendar
nix profile upgrade margin-calendar
```

On NixOS or under home-manager, add `github:priyanshujain/margin-calendar` as a flake input and
either put `margin-calendar.packages.x86_64-linux.default` in the package list or apply
`margin-calendar.overlays.default` and use `pkgs.margin-calendar`. Updating is then
`nix flake update margin-calendar` and a rebuild.

"Check for updates" inside a Nix install still checks. It reports the newer version and the
upgrade command rather than installing anything, because the package's wrapper sets
`MARGIN_CALENDAR_PACKAGED_BY=nix` and the app asks for that before it would touch its own binary,
which in the store it could not replace anyway.

It is a binary package by necessity rather than laziness. The Google OAuth client is embedded at
compile time from a file that is deliberately not in the repo, so anything built from source on
someone else's machine would run and then tell them Google Calendar is not set up.
`nix/package.nix` therefore unpacks the published `.deb`, whose payload is already a normal `/usr`
tree, and `autoPatchelfHook` points its libraries at nixpkgs.

`nix/release.json` is the pin: the version and the hash of the `.deb` that was actually published.
The `nix` job in the release workflow writes it after the manifest check passes, builds the package
once to prove the pin is good, and commits it to main. That commit is what Nix users consume:
`github:priyanshujain/margin-calendar` means main, and main means the latest release that built. A
tag's own flake still points at the release before it, because the tag is cut before the artifact
exists. If the job fails, the release is out and Nix stays a version behind until the job is rerun.

The flake is x86_64-linux only, which is the one Linux target the release builds. `flake.lock`
pins nixpkgs for anyone installing through the flake directly; the overlay uses whatever nixpkgs
the host already has. CI builds the package on every push, so a nixpkgs bump that breaks the
patching shows up before a release does.

## What the build needs

Three repository secrets, all already set:

- `GOOGLE_CREDENTIALS`, the contents of the real `google-credentials.json`. The build writes it to
  the repo root and `build.rs` embeds it. Without it the build quietly falls back to the example
  file and warns, which produces an app that runs and then says Google Calendar is not set up.
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which sign the updater
  artifacts. The public half is in `tauri.release.conf.json` and is baked into every build, so the
  private half can never be rotated without stranding everyone who has not updated yet. It lives
  in `~/.tauri/margin_calendar_updater.key` next to margin's; that copy and the password beside it
  are the only ones, so back them up somewhere that is not this machine.

The OAuth client secret ends up inside the shipped binary. That is how installed apps work and
Google does not treat it as confidential: an installed client cannot keep a secret, which is why
the flow uses PKCE and why the token exchange is safe without one.

## Updates

Installed copies check
`https://github.com/priyanshujain/margin-calendar/releases/latest/download/latest.json` and update
themselves from it. `--latest` on the publish step is what moves that pointer, so a release that
fails the manifest check stays a draft and no one is offered a broken update.
