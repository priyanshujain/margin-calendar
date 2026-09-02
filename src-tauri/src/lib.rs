mod dto;
mod google;
mod library;
mod recur;
mod store;
mod sync;

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri::Runtime;

/// The frontend treats this purely as an invalidation signal and re-requests the visible range.
pub fn emit_store_changed(app: &tauri::AppHandle, reason: &str) {
    let _ = app.emit("store-changed", reason);
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;

    let new_event = MenuItemBuilder::with_id("new-event", "New Event")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
        .accelerator("CmdOrCtrl+K")
        .build(handle)?;
    let sync_now = MenuItemBuilder::with_id("sync-now", "Sync Now")
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let accounts = MenuItemBuilder::with_id("accounts", "Google Accounts…").build(handle)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(handle)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(handle)?;
    let search = MenuItemBuilder::with_id("search", "Search…")
        .accelerator("CmdOrCtrl+F")
        .build(handle)?;
    let today = MenuItemBuilder::with_id("today", "Today")
        .accelerator("CmdOrCtrl+T")
        .build(handle)?;
    let shortcuts = MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts")
        .accelerator("CmdOrCtrl+/")
        .build(handle)?;
    let report_issue =
        MenuItemBuilder::with_id("report-issue", "Report an Issue…").build(handle)?;

    let submenus: Vec<_> = menu
        .items()?
        .into_iter()
        .filter_map(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
        .collect();

    let find_submenu = |name: &str| {
        submenus
            .iter()
            .find(|submenu| submenu.text().map(|t| t == name).unwrap_or(false))
            .cloned()
    };

    match find_submenu("File") {
        Some(submenu) => {
            submenu.prepend_items(&[
                &new_event,
                &command_palette,
                &PredefinedMenuItem::separator(handle)?,
                &sync_now,
                &accounts,
                &PredefinedMenuItem::separator(handle)?,
            ])?;
        }
        None => {
            let submenu = SubmenuBuilder::new(handle, "File")
                .item(&new_event)
                .item(&command_palette)
                .item(&PredefinedMenuItem::separator(handle)?)
                .item(&sync_now)
                .item(&accounts)
                .build()?;
            menu.insert(&submenu, 1)?;
        }
    }

    if let Some(edit) = find_submenu("Edit") {
        edit.append_items(&[&PredefinedMenuItem::separator(handle)?, &search])?;
    }

    if let Some(help) = find_submenu("Help") {
        help.append_items(&[&shortcuts, &report_issue])?;
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(app_submenu) = submenus.first() {
            app_submenu.insert(&check_updates, 1)?;
            app_submenu.insert(&settings, 3)?;
            app_submenu.insert(&PredefinedMenuItem::separator(handle)?, 4)?;
        }
        if let Some(view) = find_submenu("View") {
            let view_week = MenuItemBuilder::with_id("view-week", "Week")
                .accelerator("CmdOrCtrl+2")
                .build(handle)?;
            let view_day = MenuItemBuilder::with_id("view-day", "Day")
                .accelerator("CmdOrCtrl+1")
                .build(handle)?;
            let view_agenda = MenuItemBuilder::with_id("view-agenda", "Agenda")
                .accelerator("CmdOrCtrl+3")
                .build(handle)?;
            view.prepend_items(&[
                &view_day,
                &view_week,
                &view_agenda,
                &PredefinedMenuItem::separator(handle)?,
                &today,
                &PredefinedMenuItem::separator(handle)?,
            ])?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(file) = find_submenu("File") {
            file.append_items(&[&PredefinedMenuItem::separator(handle)?, &check_updates])?;
        }
        if let Some(edit) = find_submenu("Edit") {
            edit.append_items(&[&settings])?;
        }
        let _ = &today;
    }

    Ok(menu)
}

/// The deep link half of mobile auth: Google's answer arrives as a link into this app rather than
/// on a loopback socket. Only the flow that runs when a phone has its own OAuth client uses it, but
/// it stays registered on both platforms either way, because the OS has to be told about a scheme
/// at install time and cannot be told about one later.
///
/// Both arrival routes are covered. `on_open_url` catches the link when the app was already
/// running, which is the usual case since it is what opened the browser a moment ago;
/// `get_current` catches the one that launched a process the OS had killed in the meantime.
/// Handling it twice is harmless: `handle_redirect` takes the pending verifier rather than reading
/// it, so the second call finds nothing waiting and returns.
#[cfg(mobile)]
fn listen_for_redirects(handle: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let dispatch = |handle: &tauri::AppHandle, url: url::Url| {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            google::auth::handle_redirect(handle, &url).await;
        });
    };

    if let Ok(Some(urls)) = handle.deep_link().get_current() {
        for url in urls {
            dispatch(handle, url);
        }
    }

    let handle = handle.clone();
    handle.clone().deep_link().on_open_url(move |event| {
        for url in event.urls() {
            dispatch(&handle, url);
        }
    });
}

/// UIKit hands a scroll view the safe areas as content insets unless it is told not to, and wry
/// never tells it not to: wry 0.55.1's src/wkwebview/mod.rs:528 reaches for the scroll view only to
/// switch `bounces` off. WebKit then lays the page out in what is left over. On an iPhone 17 Pro
/// that is a layout viewport 778pt tall against an 874pt screen, still anchored at y 0, so the
/// bottom 96pt of the display is outside the page altogether. `body` is `position: fixed`, which
/// clips to that box, so nothing can paint down there whatever the CSS says: the tab bar sits in
/// the middle of the glass with a dead band of shell colour beneath it.
///
/// `never` gives the page the whole screen back. The insets are not lost, they arrive as
/// `env(safe-area-inset-*)` instead, which is where the two bars in app.css already read them from,
/// and all four viewport units finally agree on 874.
#[cfg(target_os = "ios")]
fn stop_uikit_shrinking_the_viewport(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_ui_kit::{UIScrollView, UIScrollViewContentInsetAdjustmentBehavior};

    let _ = window.with_webview(|webview| {
        // `inner()` is the WKWebView, and `with_webview` runs the closure inline when the caller is
        // already on the main thread, which setup is. So this is a plain main-thread UIKit call.
        let scroll_view: Retained<UIScrollView> =
            unsafe { objc2::msg_send![webview.inner().cast::<AnyObject>(), scrollView] };
        scroll_view
            .setContentInsetAdjustmentBehavior(UIScrollViewContentInsetAdjustmentBehavior::Never);
    });
}

/// A Chrome Custom Tab is Chrome's activity sitting on top of ours, in our own task, so this
/// process really is backgrounded for the length of a consent round trip and coming back means the
/// tab has gone. That is the only notice Android gives that the user backed out of signing in, and
/// without it the accounts panel waits on an answer that is never coming. `note_resumed` works out
/// whether the tab went because the user closed it or because this app took it down a moment after
/// the code arrived.
///
/// Not `RunEvent::Resumed`, which sounds right and is not: tauri raises that one on every poll of
/// the event loop. tao's real mobile resume arrives here, per window.
///
/// iOS shows the consent page inside the app, never leaves the foreground, and gets the same
/// question answered by a delegate in `google/browser.rs` instead.
#[cfg(target_os = "android")]
fn watch_for_the_consent_tab_closing(window: &tauri::WebviewWindow) {
    window.on_window_event(|event| {
        if matches!(event, tauri::WindowEvent::Resumed) {
            google::browser::note_resumed();
        }
    });
}

/// The other half of closing on macOS. The red button and Cmd+W hide the window rather than
/// destroy it (`on_window_event` in `run`), the way WhatsApp and Slack do: the app stays in the
/// Dock with sync still running, and Cmd+Q is what quits. AppKit does nothing of its own for a
/// Dock click when it can see no window, so bringing it back is on us. `unminimize` covers the
/// yellow button, which lands here for the same reason.
#[cfg(target_os = "macos")]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // generate_context! first, so the updater plugin registers only when the merged config
    // actually has an `updater` key. Ported from margin's lib.rs:146.
    let context = tauri::generate_context!();

    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_process::init());
        if context.config().plugins.0.contains_key("updater") {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }

    builder = builder
        .manage(google::AuthState::default())
        .manage(sync::SyncState::default())
        .setup(|app| {
            let handle = app.handle();
            let store = store::Store::open(handle)?;
            app.manage(store);
            google::auth::init_sessions(handle);
            sync::start_loop(handle.clone());
            #[cfg(mobile)]
            listen_for_redirects(handle);
            #[cfg(target_os = "ios")]
            if let Some(window) = handle.get_webview_window("main") {
                stop_uikit_shrinking_the_viewport(&window);
            }
            #[cfg(target_os = "android")]
            if let Some(window) = handle.get_webview_window("main") {
                watch_for_the_consent_tab_closing(&window);
            }
            Ok(())
        });

    #[cfg(desktop)]
    {
        builder = builder
            .menu(|handle| build_menu(handle))
            .on_menu_event(|app, event| {
                if matches!(
                    event.id().0.as_str(),
                    "new-event"
                        | "command-palette"
                        | "sync-now"
                        | "accounts"
                        | "check-updates"
                        | "settings"
                        | "search"
                        | "today"
                        | "shortcuts"
                        | "view-day"
                        | "view-week"
                        | "view-agenda"
                        | "report-issue"
                ) {
                    app.emit("menu-action", event.id().0.as_str()).ok();
                }
            });
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            google::accounts_list,
            google::account_connect,
            google::account_disconnect,
            store::calendars_list,
            store::calendar_set_selected,
            recur::instances_range,
            sync::event_create,
            sync::event_update,
            sync::event_delete,
            sync::sync_now,
            sync::sync_status,
            sync::sync_flush
        ])
        .build(context)
        .expect("error while building Margin Calendar");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            show_main_window(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
