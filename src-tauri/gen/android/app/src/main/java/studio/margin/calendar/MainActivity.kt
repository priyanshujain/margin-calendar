package studio.margin.calendar

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Android's WebView works out env(safe-area-inset-*) from the display cutout and from nothing else,
 * so the status and navigation bars overlap the page while env() still reads 0 underneath them. A
 * targetSdk of 36 makes edge to edge mandatory, so there is no overlap to opt out of: the only way
 * out is to measure the bars and tell the page. That is what this does, and the page turns the
 * numbers into --safe-top and --safe-bottom (src/safeArea.ts).
 */
class MainActivity : TauriActivity() {
  // Device pixels. Written on the UI thread by the insets listener and read on the WebView's
  // JavaScript bridge thread, which is a different one.
  @Volatile private var topPx = 0
  @Volatile private var bottomPx = 0

  inner class SafeArea {
    @JavascriptInterface fun top(): Int = topPx

    @JavascriptInterface fun bottom(): Int = bottomPx
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // wry calls this between constructing the WebView and loading the URL, which is the only point
    // at which an interface can be added and still be there for the first document.
    webView.addJavascriptInterface(SafeArea(), "__androidSafeArea")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      // The cutout is folded in rather than trusted on its own: a landscape cutout down one side
      // is not a system bar, and a hidden system bar is not a cutout, and the page has to clear
      // whichever of the two is deeper.
      val bars =
        insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
      topPx = bars.top
      bottomPx = bars.bottom
      // The page reads the bridge itself as it boots. This is for everything after that: a
      // rotation, or a switch between gesture and three button navigation, moves both numbers.
      webView.evaluateJavascript("window.dispatchEvent(new Event('androidsafearea'))", null)
      // Handed on rather than returned, because a listener stands in for the view's own handler
      // instead of running alongside it, and the WebView would otherwise see no insets at all.
      // It does not bring env(safe-area-inset-*) back on its own: that reads 0 here whatever we
      // do, which is the whole reason the page takes its numbers from the bridge above.
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
