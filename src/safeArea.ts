/**
 * The phone chrome pads with --safe-top and --safe-bottom, which are env(safe-area-inset-*) by
 * default. On iOS that is the right answer. Android's WebView reads those from the display cutout
 * alone, so a phone whose status and navigation bars are ordinary bars rather than a notch reports
 * 0 for both and the bars sit on top of the chrome. MainActivity measures the bars for real and
 * offers them here; this copies them onto the root, where they win over the env() defaults.
 *
 * Everywhere else the bridge is absent and the tokens keep their env() values untouched.
 */
interface SafeAreaBridge {
  top(): number;
  bottom(): number;
}

declare global {
  interface Window {
    __androidSafeArea?: SafeAreaBridge;
  }
}

export function trackSafeArea(): void {
  const write = () => {
    const bridge = window.__androidSafeArea;
    if (!bridge) return;
    // The bridge counts device pixels because that is what the platform hands it, and the page is
    // laid out in CSS pixels.
    const ratio = window.devicePixelRatio || 1;
    const root = document.documentElement.style;
    root.setProperty("--safe-top", `${bridge.top() / ratio}px`);
    root.setProperty("--safe-bottom", `${bridge.bottom() / ratio}px`);
  };

  write();
  // Fired by MainActivity whenever the insets are applied again, which is a rotation, a keyboard,
  // or the navigation mode changing from a 24dp gesture pill to a 48dp button bar under the app.
  window.addEventListener("androidsafearea", write);
}
