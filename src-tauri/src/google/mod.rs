// auth.rs     OAuth, token refresh. Loopback on desktop, a deep link on mobile.
// api.rs      typed Google Calendar REST wrapper
// secrets.rs  refresh tokens, encrypted on disk, same on every platform

pub mod api;
pub mod auth;
pub mod secrets;

use crate::dto::Account;

pub use auth::AuthState;

#[tauri::command]
pub async fn accounts_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<Vec<Account>, String> {
    auth::list_accounts(&app, &state).await
}

/// Returns the consent URL. Completion arrives on the frontend as the `auth` event.
#[tauri::command]
pub async fn account_connect(app: tauri::AppHandle) -> Result<String, String> {
    auth::connect(app).await
}

#[tauri::command]
pub async fn account_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
    account_id: String,
) -> Result<(), String> {
    auth::disconnect(&app, &state, &account_id).await
}
