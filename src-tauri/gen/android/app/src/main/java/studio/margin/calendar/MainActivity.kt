package studio.margin.calendar

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Two things Rust cannot reach on Android without JNI, both published to the page as JavaScript
 * bridges and both driven from Rust with webview.eval.
 *
 * The first is the window insets. Android's WebView works out env(safe-area-inset-*) from the
 * display cutout and from nothing else, so the status and navigation bars overlap the page while
 * env() still reads 0 underneath them. A targetSdk of 36 makes edge to edge mandatory, so there is
 * no overlap to opt out of: the only way out is to measure the bars and tell the page. The page
 * turns the numbers into --safe-top and --safe-bottom (src/safeArea.ts).
 *
 * The second is the Chrome Custom Tab that shows Google's consent page (src-tauri/src/google/
 * browser.rs). It has to be a Custom Tab rather than a WebView, because Google refuses to sign
 * anyone in through a WebView the app owns, and rather than an ordinary browser Intent, because
 * that would put this app in the background where its loopback listener stops accepting.
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

  inner class AuthTab {
    /**
     * Runs on the WebView's bridge thread rather than the UI thread, which is fine: starting an
     * activity touches no view hierarchy. Every exit lands the user on the consent page somehow,
     * because a sign-in that opens nothing at all is the one outcome with no way back.
     */
    @JavascriptInterface
    fun open(url: String) {
      val uri = Uri.parse(url)
      // Null when no installed browser implements Custom Tabs, which is rare and still possible on
      // a stripped image or an old device.
      val browser = CustomTabsClient.getPackageName(this@MainActivity, null)
      if (browser != null) {
        try {
          val tab = CustomTabsIntent.Builder().setShowTitle(true).build()
          tab.intent.setPackage(browser)
          tab.launchUrl(this@MainActivity, uri)
          return
        } catch (e: Exception) {
          Logger.warn("could not open a custom tab: $e")
        }
      }
      // The old behaviour, and a worse one: this hands the user to a separate browser app, which
      // backgrounds this process. The listener survives a short trip but the whole point of the
      // tab above is not to take one.
      startActivity(Intent(Intent.ACTION_VIEW, uri))
    }

    /**
     * A Custom Tab belongs to Chrome and cannot be closed by the app that launched it. What can be
     * done is to bring this activity back to the front of the task the tab was launched into, which
     * pops the tab off on the way. Same move AppAuth makes, and the background-start restrictions
     * do not apply because this activity is already in that task's back stack.
     */
    @JavascriptInterface
    fun close() {
      val intent = Intent(this@MainActivity, MainActivity::class.java)
      intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      startActivity(intent)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // wry calls this between constructing the WebView and loading the URL, which is the only point
    // at which an interface can be added and still be there for the first document.
    webView.addJavascriptInterface(SafeArea(), "__androidSafeArea")
    webView.addJavascriptInterface(AuthTab(), "__androidAuthTab")

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
