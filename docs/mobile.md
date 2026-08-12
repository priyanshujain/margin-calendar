# Android and iOS

The same Rust core and the same React app, with a different shape of chrome and a different way of
getting a token back from Google. Nothing is forked: the layout switches on a `data-phone`
attribute and the OAuth flow switches on `cfg(mobile)`.

## Google will not let you reuse the desktop client

This is the part that cannot be automated away, so do it first or nothing will sign in.

Google issues OAuth clients per platform and refuses one in another's place. The desktop client
redirects to a loopback port; Google rejects loopback redirects for Android and iOS client types
outright, and iOS will not dependably keep a listener alive to catch one anyway. So a phone build
redirects to a custom URI scheme instead, and needs its own client to do it.

Both mobile clients are **public**: no client secret exists, and PKCE is the only thing between an
intercepted authorization code and a token. That is why the verifier is not optional anywhere in
`auth.rs`.

In the Google Cloud console, on the same project that already has the Calendar API enabled:

1. Create an OAuth client of type **Android**. It wants the package name, which is
   `studio.margin.calendar`, and the SHA-1 fingerprint of the certificate that signs the build.
   For a debug build that is the shared debug keystore:

   ```
   keytool -list -v -keystore ~/.android/debug.keystore \
     -alias androiddebugkey -storepass android -keypass android
   ```

   A release build is signed with a different key and needs its fingerprint added too. An APK
   signed by a key Google has not been told about fails at consent, not at build.

2. Create an OAuth client of type **iOS**. It wants the bundle identifier, which is also
   `studio.margin.calendar`.

3. Put both client ids in `google-credentials.json` alongside the desktop one, matching
   `google-credentials.example.json`:

   ```json
   {
     "installed": { "client_id": "...", "client_secret": "...", "...": "..." },
     "android": { "client_id": "YOUR_ANDROID_CLIENT_ID.apps.googleusercontent.com" },
     "ios": { "client_id": "YOUR_IOS_CLIENT_ID.apps.googleusercontent.com" }
   }
   ```

   The file is gitignored and embedded at build time. A build with no `android` or `ios` block
   compiles and then says so at runtime rather than failing to compile, which is the same bargain
   the desktop client already had.

## The redirect schemes

Android redirects to `studio.margin.calendar:/oauth2redirect`. That is the package name, which is
Google's documented form for an Android client, and being known at build time means it can sit in
`AndroidManifest.xml` permanently rather than being pasted in per install.

iOS gets no such choice. Google requires the reversed client id, so the scheme is only knowable
once your client id is: take the client id, drop the `.apps.googleusercontent.com` suffix, and
prefix `com.googleusercontent.apps.`.

Register it in `src-tauri/tauri.conf.json`, as a second entry in the deep link plugin's scheme
list:

```json
"deep-link": {
  "desktop": { "schemes": ["studio.margin.calendar"] },
  "mobile": [{ "scheme": ["studio.margin.calendar", "com.googleusercontent.apps.YOUR_ID"] }]
}
```

Not in `Info.plist`. Editing that by hand looks like it works and then silently stops working: the
plugin's build script rewrites `CFBundleURLTypes` wholesale from this config on every build, and
when the `mobile` array is empty it deletes the key outright. That one empty array is why the
callback was dead on both platforms at first, so if a deep link ever stops arriving, look here
before anywhere else.

If the console shows you something different from either default, put it in the client's block in
`google-credentials.json` as `redirect_uri` and it wins over both. Whatever you put there still
has to have its scheme registered above, or the OS has no reason to hand the link to this app.

## Toolchain

iOS needs Xcode and the iOS Rust targets:

```
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

Android needs the SDK, an NDK of r25 or newer, a JDK that the generated Gradle build accepts (21
works, 25 does not), and the four Android Rust targets:

```
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
```

## Building

```
pnpm tauri ios init          # once, generates the Xcode project
pnpm tauri ios dev           # simulator, with the Vite dev server
pnpm tauri ios build

pnpm tauri android init      # once, generates the Gradle project
pnpm tauri android dev       # emulator or attached device
pnpm tauri android build
```

The generated projects are committed. Re-running `init` overwrites them, so check afterwards that
`MainActivity.kt` still publishes the window insets, since nothing else on Android does.

Both `dev` commands start Vite themselves and fail outright if port 1430 is already taken, which
it will be if a browser dev server is still up. Kill it, or pass a different port through
`--config`.

Three failures that look like bugs and are not. Xcode refusing to build with "Entitlements file
was modified during the build" is a stale mtime in DerivedData, fixed once by deleting
`~/Library/Developer/Xcode/DerivedData/margin-calendar-*`. An Android run panicking with "failed
to build WebSocket client, Connection refused" is a stale
`$TMPDIR/studio.margin.calendar-server-addr` pointing at a dead port; delete it. And an emulator
that will not boot by name usually means `avdmanager` and `emulator` disagree about where AVDs
live, which `ANDROID_AVD_HOME` settles.

Finally, an empty calendar on a device is correct. The browser fixture is gated on not being
inside Tauri, so on a phone the real backend answers and there is nothing to show until an account
is connected. Events without signing in only ever happen in a browser.

## What is different on a phone

The desktop header carries three groups of controls across one row, which does not fit in 390
points. Under `data-phone` it becomes a top bar with the date and the day arrows and a bottom tab
bar with the views, and everything the trailing icon row used to hold moves into an overflow
sheet. Overlays become bottom sheets. Both bars pad themselves out of the way of the notch and the
home indicator with `env(safe-area-inset-*)`.

Under `data-touch`, which a tablet gets and a narrow desktop window does not, interaction changes
rather than layout. Anything that only appeared on hover is always visible instead, because a
finger cannot hover. Dragging out a new event waits for a long press, because on a touchscreen the
alternative is that every tap on an empty afternoon starts creating something.

Navigation still moves one day at a time. A swipe is one day, not one week.

Both attributes are also set by the boot script in `index.html` before first paint, so a phone
does not render the desktop layout for a frame and then jump.

## Keeping out from under the system bars

`--safe-top` and `--safe-bottom` are `env(safe-area-inset-*)` by default, which is correct on iOS
and wrong on Android in a way that is easy to miss. Android's WebView derives those values from the
display cutout alone and never from the system bars, so it reports 0 at the bottom while the
navigation bar really occupies 24dp of gesture pill or 48dp of buttons, and the tab bar renders
underneath it. `targetSdk` is 36, so edge-to-edge is mandatory and there is nothing to opt out of.
The top only looked right on a test device by luck, because that device had a cutout; a phone
without one would have tucked the top bar under the status bar for the same reason.

So Android measures the bars natively. `MainActivity.kt` reads `systemBars() or displayCutout()`
from `WindowInsetsCompat`, exposes them over a JavaScript bridge, and re-fires on every inset
change, which covers rotation, the keyboard, and switching between gesture and button navigation
live. `src/safeArea.ts` converts device pixels to CSS pixels and writes the two variables onto the
root, where they beat the `env()` defaults. Off Android the bridge is simply absent and the
defaults stand, so iOS and desktop are untouched.

Two consequences worth knowing. `tauri android init` regenerates `MainActivity.kt`, and nothing
else on Android supplies these values, so check the bridge is still there after re-running it.
And installing the inset listener makes `env(safe-area-inset-*)` read 0 inside that WebView, which
does not matter only because those two token lines are the sole consumers and the bridge overrides
both with better numbers. Anything new that reaches for `env()` directly on Android will get zero.

iOS needed one line of native code for the same class of problem, in the opposite direction.

UIKit hands a scroll view the safe areas as content insets unless told otherwise, and wry never
tells it otherwise: it touches the scroll view only to switch `bounces` off. WebKit then lays the
page out in what is left. On an iPhone 17 Pro that meant a layout viewport 778pt tall against an
874pt screen, still anchored at y 0, so the bottom 96pt of the display was outside the page
altogether and showed as a dead band of shell colour under the tab bar. `body` is
`position: fixed`, so nothing could paint down there whatever the stylesheet said.

`stop_uikit_shrinking_the_viewport` in `lib.rs` sets `contentInsetAdjustmentBehavior` to `never`
through `with_webview`, which gives the page the whole screen back. The insets are not lost, they
arrive as `env(safe-area-inset-*)` instead, which is where both bars already read them from.

Worth knowing before anyone tries to solve that in CSS, because it looks like a CSS problem and
the obvious fix is worse than the bug. While the viewport was short, `100dvh` was the only unit
reporting the real box; `vh`, `svh` and `lvh` all reported the full screen. Sizing the root
`100svh` therefore did not reclaim the bottom of the screen, it laid the tab bar out past the clip
where it was invisible and, less obviously, untappable. The root is `height: 100%`, which inherits
whatever the box is and cannot drift if the native line ever regresses.

## Limits worth knowing

There is no auto-updater and no process restart on mobile: the store is the update channel, and
both plugins are compiled out rather than merely hidden.

The initial sync pulls the whole calendar history, because Google forbids `timeMin` alongside a
`syncToken`. That is already the desktop behaviour and it is slower on a phone radio.
