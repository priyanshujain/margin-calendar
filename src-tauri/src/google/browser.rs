// Where the consent page is shown on a phone, and how it is taken away again.
//
// Desktop hands the URL to the system browser and forgets about it. The loopback listener is the
// only thing that has to survive, and a desktop process keeps running perfectly well while another
// window has focus. A phone does not work that way: sending the user out to Safari or Chrome
// backgrounds this process, iOS suspends it, and a suspended process accepts nothing on its socket,
// so the redirect carrying the authorization code arrives at nobody.
//
// So the consent page is put in front of the app instead, by the system's own browser component.
// Never a WebView this app owns: Google blocks that outright with `disallowed_useragent`, and it
// deserves to be blocked, because a webview the app controls can read what is typed into it. What
// this app gets in return for not owning it is to stay foreground, with its listener still
// accepting, for as long as consent takes.
//
// Three surfaces, because the platforms do not offer the same thing.
//
//   Chrome Custom Tab, Android. Chrome itself, so it reads Chrome's cookie jar and an account
//   already signed in there is offered by name. Nothing else is needed on Android.
//
//   SFSafariViewController, iOS, when there is no `ios` OAuth client. Safari's engine, but with
//   storage of this app's own since iOS 11, so the user signs in from scratch inside it. It works
//   with no console setup at all, which is the only reason to accept that.
//
//   ASWebAuthenticationSession, iOS, when there is one. The only iOS surface that shares Safari's
//   session, and the one to prefer, but it intercepts a custom scheme and never an http loopback
//   redirect, so it is reachable only where an `ios` client has bought a scheme.
//
// The first two are `open`/`close`: they know nothing about the answer, so the loopback listener
// stays the thing that decides an attempt is over, and the two flags below carry the one fact it
// cannot see for itself. `authenticate` is the third and reports its own outcome.

use std::sync::atomic::{AtomicBool, Ordering};

/// Set while the consent page is up and the listener is still waiting on it. Only a dismissal
/// during that window means anything: the same signals fire when this app takes the browser down
/// itself, a moment after the code has already arrived.
static WAITING: AtomicBool = AtomicBool::new(false);

/// Set when the user closed the browser without finishing. `await_code` polls it rather than being
/// interrupted, which costs up to one poll interval and keeps the listener loop the only thing that
/// decides when a consent attempt is over.
static DISMISSED: AtomicBool = AtomicBool::new(false);

pub fn open(app: &tauri::AppHandle, url: &str) {
    DISMISSED.store(false, Ordering::SeqCst);
    WAITING.store(true, Ordering::SeqCst);
    present(app, url);
}

pub fn close(app: &tauri::AppHandle) {
    WAITING.store(false, Ordering::SeqCst);
    dismiss(app);
}

pub fn cancelled() -> bool {
    DISMISSED.load(Ordering::SeqCst)
}

/// The user closed the consent page: the Done button on iOS, Back or a swipe on Android.
pub fn note_dismissed() {
    if WAITING.load(Ordering::SeqCst) {
        DISMISSED.store(true, Ordering::SeqCst);
    }
}

/// iOS presents the consent page inside this app, so this process never leaves the foreground and
/// there is nothing to hook. Android's Custom Tab is a Chrome activity on top of ours, so this app
/// really does go to the background and coming back is the signal: the tab is in this app's own
/// task, and the only way out of it is dismissal. `close` clears `WAITING` before it brings the
/// activity forward, so the resume this app asks for itself is not mistaken for the user's.
#[cfg(target_os = "android")]
pub fn note_resumed() {
    note_dismissed();
}

/// The other iOS surface, and the one to prefer where a custom scheme exists to make it possible.
/// Nothing to do with the two flags above: it reports its own cancel, because it has a completion
/// handler to report it through and no listener to interrupt.
#[cfg(target_os = "ios")]
pub fn authenticate(app: &tauri::AppHandle, url: &str, scheme: &str) {
    ios::authenticate(app, url, scheme);
}

#[cfg(target_os = "ios")]
fn present(app: &tauri::AppHandle, url: &str) {
    ios::present(app, url);
}

#[cfg(target_os = "ios")]
fn dismiss(app: &tauri::AppHandle) {
    ios::dismiss(app);
}

#[cfg(target_os = "ios")]
mod ios {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, NSObject, Sel};
    use objc2::{msg_send, sel, ClassType};
    use objc2_foundation::{NSError, NSString, NSURL};
    use tauri::Manager;

    use std::cell::RefCell;

    // SFSafariViewController has no objc2 binding: objc2-safari-services covers the macOS extension
    // API and nothing else. Linking the framework by hand is what puts the class in the process at
    // all, after which it can be looked up by name.
    #[link(name = "SafariServices", kind = "framework")]
    extern "C" {}

    thread_local! {
        /// The presented controller and the delegate it reports to, kept only so they can be found
        /// again: UIKit holds a delegate weakly, and a controller nothing retains is a controller
        /// that deallocates mid-flow. Both slots are main thread only, which is where every line in
        /// this module runs.
        static PRESENTED: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static DELEGATE: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    /// SFSafariViewController calls this when the user taps Done, and never when the dismissal came
    /// from `dismiss` below. UIKit takes the controller off screen on its own here, so there is
    /// nothing to do but let go of it and say what happened.
    extern "C-unwind" fn did_finish(_this: &AnyObject, _cmd: Sel, _controller: *mut AnyObject) {
        PRESENTED.with(|slot| slot.borrow_mut().take());
        DELEGATE.with(|slot| slot.borrow_mut().take());
        super::note_dismissed();
    }

    /// Registered once, lazily, because a class pair can only be registered under a given name
    /// once per process. SFSafariViewControllerDelegate is checked with `respondsToSelector:`
    /// rather than `conformsToProtocol:`, so declaring the one method is enough and there is no
    /// protocol to adopt.
    fn delegate_class() -> &'static AnyClass {
        thread_local! {
            static CLASS: &'static AnyClass = {
                let mut builder = ClassBuilder::new(c"MarginConsentDelegate", NSObject::class())
                    .expect("MarginConsentDelegate is registered once and by nobody else");
                unsafe {
                    builder.add_method(
                        sel!(safariViewControllerDidFinish:),
                        did_finish as extern "C-unwind" fn(_, _, _),
                    );
                }
                builder.register()
            };
        }
        CLASS.with(|class| *class)
    }

    pub fn present(app: &tauri::AppHandle, url: &str) {
        let Some(window) = app.get_webview_window("main") else {
            return crate::google::auth::open_in_browser(app, url);
        };
        let inner_app = app.clone();
        let inner_url = url.to_string();
        let posted = window.with_webview(move |webview| {
            // `with_webview` hands the WKWebView over on the main thread, which is both where UIKit
            // needs this and where the two slots above live. Its window is the app's own, so the
            // sheet comes up over the calendar rather than over whatever else UIKit would have
            // picked.
            let presented = unsafe {
                let view = webview.inner().cast::<AnyObject>();
                let ui_window: Option<Retained<AnyObject>> = msg_send![view, window];
                let root: Option<Retained<AnyObject>> = match &ui_window {
                    Some(ui_window) => msg_send![&**ui_window, rootViewController],
                    None => None,
                };
                match root {
                    Some(root) => show(&root, &inner_url),
                    None => false,
                }
            };
            if !presented {
                crate::google::auth::open_in_browser(&inner_app, &inner_url);
            }
        });
        if posted.is_err() {
            crate::google::auth::open_in_browser(app, url);
        }
    }

    /// Everything that can be missing here is missing for the same reason: an iOS that does not
    /// have the class, or a URL the OS will not parse. Both answer false and the caller falls back
    /// to the external browser rather than leaving the user looking at nothing.
    unsafe fn show(root: &AnyObject, url: &str) -> bool {
        let Some(class) = AnyClass::get(c"SFSafariViewController") else {
            return false;
        };
        let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
            return false;
        };

        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        let controller: Option<Retained<AnyObject>> = msg_send![allocated, initWithURL: &*url];
        let Some(controller) = controller else {
            return false;
        };

        let delegate: Retained<AnyObject> = msg_send![delegate_class(), new];
        let () = msg_send![&*controller, setDelegate: &*delegate];
        DELEGATE.with(|slot| *slot.borrow_mut() = Some(delegate));

        let completion: Option<&DynBlock<dyn Fn()>> = None;
        let () = msg_send![root, presentViewController: &*controller, animated: true, completion: completion];
        PRESENTED.with(|slot| *slot.borrow_mut() = Some(controller));
        true
    }

    pub fn dismiss(app: &tauri::AppHandle) {
        let _ = app.run_on_main_thread(|| {
            let Some(controller) = PRESENTED.with(|slot| slot.borrow_mut().take()) else {
                return;
            };
            DELEGATE.with(|slot| slot.borrow_mut().take());
            unsafe {
                let completion: Option<&DynBlock<dyn Fn()>> = None;
                // Sent to the presented controller rather than the presenting one, which UIKit
                // forwards. Letting go of the last reference afterwards is safe: the presenting
                // controller holds it for the length of the animation.
                let () = msg_send![&*controller, dismissViewControllerAnimated: true, completion: completion];
            }
        });
    }

    // The second iOS surface, and the better one. See `authenticate` for what it buys.
    #[link(name = "AuthenticationServices", kind = "framework")]
    extern "C" {}

    /// `ASWebAuthenticationSessionErrorCodeCanceledLogin`. The user closed the sheet, which is not
    /// a failure worth dressing up as one.
    const CANCELED_LOGIN: isize = 1;

    thread_local! {
        /// The session, the object that tells it which window to present over, and that window.
        ///
        /// A session nothing retains deallocates and then simply never calls back, which is the
        /// classic way to lose an afternoon to this API, and the presentation context provider is
        /// held weakly so it goes the same way. Replaced on the next attempt rather than cleared in
        /// the completion handler, because the session owns the block that handler lives in and
        /// releasing it from inside its own invocation is asking for a use after free.
        static SESSION: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static ANCHOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        static ANCHOR_WINDOW: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    /// Required from iOS 13 on: with no anchor the session refuses to start and reports
    /// `presentationContextNotProvided` instead. Returned unretained, which is the convention for
    /// a getter like this one, and safe because ANCHOR_WINDOW holds it for the flow.
    extern "C-unwind" fn presentation_anchor(
        _this: &AnyObject,
        _cmd: Sel,
        _session: *mut AnyObject,
    ) -> *mut AnyObject {
        ANCHOR_WINDOW.with(|slot| match slot.borrow().as_ref() {
            Some(window) => Retained::as_ptr(window).cast_mut(),
            None => std::ptr::null_mut(),
        })
    }

    fn anchor_class() -> &'static AnyClass {
        thread_local! {
            static CLASS: &'static AnyClass = {
                let mut builder = ClassBuilder::new(c"MarginConsentAnchor", NSObject::class())
                    .expect("MarginConsentAnchor is registered once and by nobody else");
                unsafe {
                    builder.add_method(
                        sel!(presentationAnchorForWebAuthenticationSession:),
                        presentation_anchor as extern "C-unwind" fn(_, _, _) -> _,
                    );
                }
                builder.register()
            };
        }
        CLASS.with(|class| *class)
    }

    /// The consent page in an `ASWebAuthenticationSession`, which is the same Safari view underneath
    /// but with Safari's own cookies rather than a jar of this app's alone. That is the whole point
    /// of it: an account already signed in on this phone is offered by name instead of asking for a
    /// password again. It is also why iOS puts up its own "wants to use google.com to sign in"
    /// prompt first, since sharing the session is something the user gets to refuse.
    ///
    /// The price is that it only ever intercepts a custom scheme, never an http loopback redirect,
    /// so this path exists only where a scheme exists: an `ios` block in the credentials file.
    pub fn authenticate(app: &tauri::AppHandle, url: &str, scheme: &str) {
        let Some(window) = app.get_webview_window("main") else {
            return crate::google::auth::open_in_browser(app, url);
        };
        let inner_app = app.clone();
        let inner_url = url.to_string();
        let scheme = scheme.to_string();
        let posted = window.with_webview(move |webview| {
            let started = unsafe {
                let view = webview.inner().cast::<AnyObject>();
                let ui_window: Option<Retained<AnyObject>> = msg_send![view, window];
                match ui_window {
                    Some(ui_window) => start(&inner_app, ui_window, &inner_url, &scheme),
                    None => false,
                }
            };
            if !started {
                crate::google::auth::open_in_browser(&inner_app, &inner_url);
            }
        });
        if posted.is_err() {
            crate::google::auth::open_in_browser(app, url);
        }
    }

    unsafe fn start(
        app: &tauri::AppHandle,
        ui_window: Retained<AnyObject>,
        url: &str,
        scheme: &str,
    ) -> bool {
        let Some(class) = AnyClass::get(c"ASWebAuthenticationSession") else {
            return false;
        };
        let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
            return false;
        };
        let scheme = NSString::from_str(scheme);

        let handler_app = app.clone();
        let handler = RcBlock::new(move |callback: *mut NSURL, error: *mut NSError| {
            finished(&handler_app, callback, error);
        });

        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        let session: Option<Retained<AnyObject>> = msg_send![
            allocated,
            initWithURL: &*url,
            callbackURLScheme: &*scheme,
            completionHandler: &*handler,
        ];
        let Some(session) = session else {
            return false;
        };

        // False, not true: an ephemeral session is a fresh cookie jar, which throws away the one
        // reason to be using this API at all.
        let () = msg_send![&*session, setPrefersEphemeralWebBrowserSession: false];

        let anchor: Retained<AnyObject> = msg_send![anchor_class(), new];
        let () = msg_send![&*session, setPresentationContextProvider: &*anchor];
        ANCHOR_WINDOW.with(|slot| *slot.borrow_mut() = Some(ui_window));
        ANCHOR.with(|slot| *slot.borrow_mut() = Some(anchor));

        let started: bool = msg_send![&*session, start];
        SESSION.with(|slot| *slot.borrow_mut() = Some(session));
        started
    }

    /// One of three answers: the callback URL, a cancel, or a real failure. The URL goes to the same
    /// `handle_redirect` the deep link uses, so the state check and the exchange stay in one place
    /// and this knows nothing about either.
    fn finished(app: &tauri::AppHandle, callback: *mut NSURL, error: *mut NSError) {
        if !callback.is_null() {
            let absolute = unsafe {
                let string: Retained<NSString> = msg_send![callback, absoluteString];
                string.to_string()
            };
            if let Ok(parsed) = url::Url::parse(&absolute) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::google::auth::handle_redirect(app, &parsed).await;
                });
            }
            return;
        }

        let code = if error.is_null() {
            CANCELED_LOGIN
        } else {
            unsafe { msg_send![error, code] }
        };
        let reason = if code == CANCELED_LOGIN {
            None
        } else {
            Some(format!("The sign-in sheet could not be shown (error {code})."))
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::google::auth::abandon_pending(app, reason).await;
        });
    }
}

/// Android has no equivalent of `with_webview`, and reaching a Custom Tab from here would mean JNI
/// in Rust for the sake of one Intent. It goes through the JavaScript bridge in `MainActivity.kt`
/// instead, which is the same shape as the window insets bridge that is already there.
///
/// That bridge is the one thing this depends on, and `tauri android init` regenerates the file it
/// lives in. Without it the script below is a no-op and nothing opens at all, which is why
/// docs/mobile.md says to check for it after running init.
#[cfg(target_os = "android")]
fn present(app: &tauri::AppHandle, url: &str) {
    let literal = match serde_json::to_string(url) {
        Ok(literal) => literal,
        Err(_) => return crate::google::auth::open_in_browser(app, url),
    };
    if eval(app, &format!("window.__androidAuthTab?.open({literal})")).is_err() {
        crate::google::auth::open_in_browser(app, url);
    }
}

#[cfg(target_os = "android")]
fn dismiss(app: &tauri::AppHandle) {
    let _ = eval(app, "window.__androidAuthTab?.close()");
}

#[cfg(target_os = "android")]
fn eval(app: &tauri::AppHandle, script: &str) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("there is no window to run the bridge from")?;
    window.eval(script).map_err(|e| e.to_string())
}
