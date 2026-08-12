// The OAuth desktop flow, ported from margin/src-tauri/src/gdrive.rs with three fixes:
//
//   1. HTTP gets real timeouts. margin's `LazyLock::new(reqwest::Client::new)` has none, which a
//      polling client cannot afford.
//   2. valid_access_token is single-flight. N concurrent calendar syncs must not all refresh.
//   3. Disconnect wipes the whole store for that account, not just the token, so reconnecting as
//      a different account cannot write against stale remote ids.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::LazyLock;
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::dto::{Account, AuthEvent};
use crate::google::secrets;

pub const SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar";

/// How long the listener waits for Google to come back. Two minutes is generous on a desktop, where
/// the browser is a window away and a keyboard is a keyboard.
#[cfg(desktop)]
pub const AUTH_TIMEOUT_SECS: u64 = 120;

/// The same wait on a phone, which has to cover an email and a password typed on glass, a password
/// manager round trip, and very often a 2FA prompt in a third app.
#[cfg(mobile)]
pub const AUTH_TIMEOUT_SECS: u64 = 900;

/// The same again for the deep link flow, where the wait is even less this app's to control: the
/// browser is a separate app there, so this process may be backgrounded for all of it while it does
/// nothing but hold a verifier.
#[cfg(mobile)]
pub const PENDING_TIMEOUT_SECS: u64 = 900;

/// Refresh this many seconds before Google would expire the token, so a request in flight when the
/// clock rolls over does not come back 401.
const EXPIRY_SKEW_SECS: u64 = 60;

const CREDENTIALS_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/google-credentials.json"));

pub static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("could not build the HTTP client")
});

/// Up to three OAuth clients, of which a build uses exactly one.
///
/// `installed` is a Desktop client: confidential, so it has a secret, and allowed to redirect to
/// loopback on any port without registering it first. `android` and `ios` are public clients with
/// no secret at all, and they redirect to a custom URI scheme instead.
///
/// A phone uses `installed` unless its own block is present, which is a deliberate choice and the
/// reason mobile sign-in needs no console work. `connect` says what the two flows cost.
#[derive(Deserialize)]
struct CredentialsFile {
    installed: Credentials,
    #[serde(default)]
    android: Option<Credentials>,
    #[serde(default)]
    ios: Option<Credentials>,
}

#[derive(Deserialize)]
pub struct Credentials {
    pub client_id: String,
    /// Absent for Android and iOS clients. A public client has nothing to keep secret, so PKCE is
    /// the only thing standing between an intercepted code and a token, which is why the verifier
    /// is not optional anywhere in this file.
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default = "default_auth_uri")]
    pub auth_uri: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
    /// Mobile only, and only when Google's console shows something other than the default below.
    #[serde(default)]
    pub redirect_uri: Option<String>,
    /// Set at load time rather than read from the file: true when this client came out of the
    /// `android` or `ios` block. It is the only thing that decides which of the two mobile flows
    /// runs, so it travels with the client that forces the choice rather than being worked out
    /// again wherever the answer is needed.
    #[serde(skip)]
    pub platform_client: bool,
}

fn default_auth_uri() -> String {
    "https://accounts.google.com/o/oauth2/auth".to_string()
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

/// The custom URI scheme an Android build redirects to. It is the package name, which is Google's
/// documented form for an Android client and, unlike the reversed client id, is known at build
/// time, so it can sit in AndroidManifest.xml rather than being pasted in per install.
#[cfg(target_os = "android")]
pub const ANDROID_REDIRECT: &str = "studio.margin.calendar:/oauth2redirect";

/// iOS gets no such choice: Google requires the reversed client id, so the scheme is only knowable
/// once the client id is. `docs/mobile.md` says which line of Info.plist to put it on.
#[cfg(target_os = "ios")]
fn reversed_client_id(client_id: &str) -> String {
    let base = client_id
        .strip_suffix(".apps.googleusercontent.com")
        .unwrap_or(client_id);
    format!("com.googleusercontent.apps.{base}:/oauth2redirect")
}

const NOT_SET_UP: &str = "Google Calendar is not set up yet. Add a real OAuth client to google-credentials.json and rebuild.";

/// The one client this build signs in with. A missing platform block is not an error: it means the
/// desktop client and the loopback flow, which is what a phone gets until somebody decides
/// otherwise. Every caller has to agree on the answer, because a refresh token belongs to the
/// client that obtained it.
pub fn load_credentials() -> Result<Credentials, String> {
    let parsed: CredentialsFile = serde_json::from_str(CREDENTIALS_JSON)
        .map_err(|e| format!("invalid google-credentials.json: {e}"))?;

    #[cfg(target_os = "android")]
    let (mut creds, platform_client) = match parsed.android {
        Some(creds) => (creds, true),
        None => (parsed.installed, false),
    };
    #[cfg(target_os = "ios")]
    let (mut creds, platform_client) = match parsed.ios {
        Some(creds) => (creds, true),
        None => (parsed.installed, false),
    };
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let (mut creds, platform_client) = (parsed.installed, false);
    creds.platform_client = platform_client;

    if creds.client_id.starts_with("YOUR_CLIENT_ID")
        || creds
            .client_secret
            .as_deref()
            .is_some_and(|secret| secret.starts_with("YOUR_CLIENT_SECRET"))
    {
        return Err(NOT_SET_UP.to_string());
    }
    Ok(creds)
}

/// Where Google sends the browser back to on the custom scheme flow. The loopback flow binds a port
/// per attempt and works its own redirect out in `connect_by_loopback`, so this is only for the
/// platforms that have been given their own client.
#[cfg(mobile)]
pub fn redirect_uri(creds: &Credentials) -> String {
    if let Some(explicit) = &creds.redirect_uri {
        return explicit.clone();
    }
    #[cfg(target_os = "android")]
    {
        ANDROID_REDIRECT.to_string()
    }
    #[cfg(not(target_os = "android"))]
    {
        reversed_client_id(&creds.client_id)
    }
}

/// Reads the body to a String first so Google's error payload survives into the message.
/// Ported from gdrive.rs:286.
pub async fn read_json<T: DeserializeOwned>(
    resp: reqwest::Response,
    context: &str,
) -> Result<T, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{context} failed ({status}): {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("{context}: could not parse response: {e}"))
}

#[derive(Default)]
pub struct Session {
    pub access_token: Option<String>,
    pub access_expiry: u64,
    pub email: Option<String>,
}

/// A consent round trip that has left for the browser and not come back.
///
/// Desktop does not need this: the loopback listener holds the verifier on its own stack for the
/// two minutes it is alive. Mobile has no listener. The browser is a separate app, this process
/// may be backgrounded while the user consents, and the answer arrives later as a deep link with
/// nothing but a code and a state parameter, so the verifier has to be waiting for it here.
#[cfg(mobile)]
pub struct Pending {
    pub state: String,
    pub verifier: String,
    pub redirect: String,
    pub expires: u64,
}

/// One entry per connected account. The outer Mutex is tokio's, not std's, because
/// `valid_access_token` holds it across the refresh await to keep refresh single-flight.
#[derive(Default)]
pub struct AuthState {
    pub sessions: Mutex<HashMap<String, Session>>,
    #[cfg(mobile)]
    pub pending: Mutex<Option<Pending>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn write_http_message(stream: &mut TcpStream, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Margin Calendar</title></head>\
         <body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:80px;color:#222\">\
         <h2>{message}</h2></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[derive(Debug, PartialEq, Eq)]
enum Redirect {
    Code(String),
    Denied(String),
    Mismatch,
    /// Anything else the browser asked for on the way, including the favicon.
    Waiting,
}

fn request_path(request: &str) -> &str {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
}

fn parse_redirect(path: &str, expected_state: &str) -> Redirect {
    if path == "/favicon.ico" {
        return Redirect::Waiting;
    }
    let parsed = match url::Url::parse(&format!("http://127.0.0.1{path}")) {
        Ok(parsed) => parsed,
        Err(_) => return Redirect::Waiting,
    };
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Redirect::Denied(error);
    }
    match (code, state) {
        (Some(code), Some(state)) if state == expected_state => Redirect::Code(code),
        (Some(_), _) => Redirect::Mismatch,
        _ => Redirect::Waiting,
    }
}

/// What the frontend is told when the user backed out rather than finishing: closing the consent
/// browser on a phone, or pressing Cancel on Google's own screen anywhere.
///
/// `emit_auth` compares against this exact string to set `AuthEvent.cancelled`, which is what stops
/// the frontend reporting a change of mind as a failure. So it is a constant on every platform, and
/// every path that means "the user chose not to" must return this rather than wording its own.
const CANCELLED: &str = "Sign-in was cancelled.";

fn await_code(
    listener: TcpListener,
    expected_state: &str,
    deadline: Instant,
) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        if Instant::now() > deadline {
            return Err("Timed out waiting for Google authorization.".to_string());
        }
        // Closing the consent page is the mobile equivalent of closing the browser tab, and the
        // one abandonment the OS actually tells us about. Polled here rather than interrupting the
        // loop, so this stays the only place that decides an attempt is over.
        #[cfg(mobile)]
        if crate::google::browser::cancelled() {
            return Err(CANCELLED.to_string());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                match parse_redirect(request_path(&request), expected_state) {
                    Redirect::Code(code) => {
                        write_http_message(
                            &mut stream,
                            "Connected to Margin Calendar. You can close this tab.",
                        );
                        return Ok(code);
                    }
                    Redirect::Denied(error) => {
                        write_http_message(
                            &mut stream,
                            "Authorization was cancelled. You can close this tab.",
                        );
                        // `access_denied` is Google's word for the user pressing Cancel on the
                        // consent screen, which is the same decision as closing the browser and
                        // deserves the same quiet handling. Anything else really did go wrong.
                        if error == "access_denied" {
                            return Err(CANCELLED.to_string());
                        }
                        return Err(format!("Google authorization failed: {error}"));
                    }
                    Redirect::Mismatch => {
                        write_http_message(
                            &mut stream,
                            "Could not verify the request. You can close this tab.",
                        );
                        return Err("State mismatch during Google authorization.".to_string());
                    }
                    Redirect::Waiting => write_http_message(&mut stream, "Waiting for Google…"),
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: u64,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct UserInfo {
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct IdClaims {
    /// Google's stable user id. It survives an email change, which the email does not.
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// The id_token arrived over TLS straight from Google's token endpoint, so verifying its signature
/// would only re-prove what the transport already proved. Only the payload is read.
fn id_token_claims(id_token: &str) -> Option<IdClaims> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Google rejects an empty `client_secret` rather than ignoring it, so a public mobile client has
/// to omit the field entirely rather than send a blank one.
fn with_secret<'a>(
    creds: &'a Credentials,
    mut form: Vec<(&'a str, &'a str)>,
) -> Vec<(&'a str, &'a str)> {
    if let Some(secret) = creds.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    form
}

async fn exchange_code(
    creds: &Credentials,
    code: &str,
    redirect: &str,
    verifier: &str,
) -> Result<TokenResponse, String> {
    let form = with_secret(
        creds,
        vec![
            ("client_id", creds.client_id.as_str()),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect),
        ],
    );
    let resp = HTTP
        .post(&creds.token_uri)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    read_json(resp, "Google token exchange").await
}

async fn refresh_access_token(
    creds: &Credentials,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let form = with_secret(
        creds,
        vec![
            ("client_id", creds.client_id.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ],
    );
    let resp = HTTP
        .post(&creds.token_uri)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    read_json(resp, "Google token refresh").await
}

async fn fetch_email(access_token: &str) -> Result<String, String> {
    let resp = HTTP
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let info: UserInfo = read_json(resp, "Google account lookup").await?;
    Ok(info.email.unwrap_or_default())
}

async fn revoke(token: &str) {
    let _ = HTTP
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", token)])
        .send()
        .await;
}

/// Takes the store's connection for one synchronous unit of work. Nothing here may await: the
/// guard is a std one, so holding it across a suspension point would make the future non-Send.
fn with_conn<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or("the local store is not open")?;
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

/// Reads the row's `keychain_ref` and stops there. It deliberately does NOT open the token store
/// to confirm the secret is still present.
///
/// This runs on every `store-changed`, which sync emits on every pass, so a probe here is a file
/// read and a key derivation once a minute for an answer nothing acts on. If the secret really has
/// gone, the next `valid_access_token` says so and the failure surfaces as a sync error, which is
/// the honest place to learn it.
pub async fn list_accounts(
    app: &tauri::AppHandle,
    _state: &tauri::State<'_, AuthState>,
) -> Result<Vec<Account>, String> {
    with_conn(app, crate::store::read::accounts)
}

/// The consent URL. Identical on every platform apart from the redirect it asks Google to come
/// back to, which is the whole of the difference between the desktop and mobile flows.
///
/// select_account on top of margin's consent prompt, because adding a second account is the whole
/// point of the accounts list and Google would otherwise silently reuse the signed-in one.
fn auth_url(creds: &Credentials, redirect: &str, challenge: &str, csrf: &str) -> String {
    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt={}",
        creds.auth_uri,
        urlencode(&creds.client_id),
        urlencode(redirect),
        urlencode(SCOPES),
        challenge,
        urlencode(csrf),
        urlencode("select_account consent"),
    )
}

/// Hands the URL to whichever browser the OS considers the user's, in its own process. Never an
/// in-app webview: Google blocks the embedded-webview flow outright, and it deserves to be blocked,
/// because a webview the app controls can read what the user types into it. `browser.rs` covers the
/// mobile surfaces, which are the system's browser too and are only in front of the app rather than
/// inside it.
pub(super) fn open_in_browser(app: &tauri::AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url.to_string(), None::<&str>);
}

fn emit_auth(app: &tauri::AppHandle, outcome: Result<(String, String), String>) {
    let event = match outcome {
        Ok((account_id, email)) => {
            crate::emit_store_changed(app, "account-connected");
            AuthEvent {
                ok: true,
                error: None,
                account_id: Some(account_id),
                email: Some(email),
                cancelled: false,
            }
        }
        // Compared against the constant the cancel paths raise, rather than matched on its text,
        // so rewording it cannot quietly turn a cancel back into an error on screen.
        Err(error) => AuthEvent {
            ok: false,
            cancelled: error == CANCELLED,
            error: Some(error),
            account_id: None,
            email: None,
        },
    };
    let _ = app.emit("auth", event);
}

/// One consent request, on all five platforms.
///
/// The loopback flow is the default everywhere, phones included. Google lets a Desktop client
/// redirect to loopback on any port with nothing registered in advance, and the token endpoint
/// checks the client id, the secret and the redirect and has no idea which OS asked. What used to
/// make this impossible on a phone was not the protocol but the browser: sending the user out to
/// Safari suspends this process, and a suspended process is not accepting on its socket. An in-app
/// browser does not leave, which is why `browser.rs` exists and why this branch is now the common
/// one.
///
/// The custom scheme flow runs instead when the credentials file has a client for this platform.
/// That is Google's stated guidance, and the thing to reach for if they ever start enforcing it,
/// but on iOS it is worth having for its own sake: it is the only way to reach
/// `ASWebAuthenticationSession`, which is the only iOS browser that shares Safari's cookies.
/// docs/mobile.md has the trade in full.
pub async fn connect(app: tauri::AppHandle) -> Result<String, String> {
    let creds = load_credentials()?;
    #[cfg(mobile)]
    if creds.platform_client {
        return connect_by_deep_link(app, creds).await;
    }
    connect_by_loopback(app, creds).await
}

async fn connect_by_loopback(
    app: tauri::AppHandle,
    creds: Credentials,
) -> Result<String, String> {
    let verifier = random_b64(64);
    let challenge = pkce_challenge(&verifier);
    let csrf = random_b64(24);

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let url = auth_url(&creds, &redirect, &challenge, &csrf);

    #[cfg(desktop)]
    open_in_browser(&app, &url);
    #[cfg(mobile)]
    crate::google::browser::open(&app, &url);

    let app_bg = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = complete_auth(&app_bg, listener, csrf, verifier, redirect, creds).await;
        emit_auth(&app_bg, outcome);
    });

    Ok(url)
}

/// The custom scheme flow. What is stashed here is the PKCE verifier and the CSRF state, which is
/// the only thing tying the code that comes back to the request that went out, since there is no
/// listener holding either on its own stack.
///
/// Where the answer comes back from differs by platform, and so does what it is worth.
///
/// iOS hands the URL to `ASWebAuthenticationSession`, which reports the callback straight to a
/// completion handler. It is the only iOS surface that shares Safari's cookies, so an account
/// already signed in on the phone is offered by name rather than asking for a password again. That
/// is the reason this flow is worth the console visit on iOS, and `browser.rs` says the rest.
///
/// Android opens the external browser and waits for the deep link, which is a genuinely separate
/// app: this process may be backgrounded, or killed outright, for the whole of it. Android needs
/// none of this, because a Custom Tab already shares Chrome's cookies and the loopback flow above
/// already works, so this is only ever reached when somebody has gone and made an Android client.
#[cfg(mobile)]
async fn connect_by_deep_link(
    app: tauri::AppHandle,
    creds: Credentials,
) -> Result<String, String> {
    let verifier = random_b64(64);
    let challenge = pkce_challenge(&verifier);
    let csrf = random_b64(24);
    let redirect = redirect_uri(&creds);
    let url = auth_url(&creds, &redirect, &challenge, &csrf);

    {
        let state = app.state::<AuthState>();
        let mut pending = state.pending.lock().await;
        *pending = Some(Pending {
            state: csrf,
            verifier,
            redirect: redirect.clone(),
            expires: now() + PENDING_TIMEOUT_SECS,
        });
    }

    #[cfg(target_os = "ios")]
    crate::google::browser::authenticate(&app, &url, callback_scheme(&redirect));
    #[cfg(not(target_os = "ios"))]
    open_in_browser(&app, &url);
    Ok(url)
}

/// `ASWebAuthenticationSession` matches on the scheme alone and wants it bare, so the path and the
/// colon that `redirect_uri` builds have to come back off.
#[cfg(target_os = "ios")]
fn callback_scheme(redirect: &str) -> &str {
    redirect.split(':').next().unwrap_or(redirect)
}

/// The consent surface ended with no callback URL at all: the user closed it, or it could not be
/// shown. Either way the pending verifier is spent, and the panel is waiting on an answer that is
/// never coming, so it is told. A cancel says so plainly rather than reporting a failure.
#[cfg(mobile)]
pub async fn abandon_pending(app: tauri::AppHandle, reason: Option<String>) {
    let auth = app.state::<AuthState>();
    let pending = {
        let mut slot = auth.pending.lock().await;
        slot.take()
    };
    if pending.is_some() {
        emit_auth(&app, Err(reason.unwrap_or_else(|| CANCELLED.to_string())));
    }
}

/// Every URL the OS hands the app on a registered scheme, including ones that have nothing to do
/// with consent. A link that carries no `state` we are waiting for is ignored in silence rather
/// than reported, because another feature may want that scheme later and a stray link is not an
/// authorization failure worth putting on screen.
#[cfg(mobile)]
pub async fn handle_redirect(app: tauri::AppHandle, incoming: &url::Url) {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in incoming.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    let state = match state {
        Some(state) => state,
        None => return,
    };

    // Taken, not read: a code is good once, so leaving the verifier in place would let a replayed
    // link start a second exchange.
    let auth = app.state::<AuthState>();
    let pending = {
        let mut slot = auth.pending.lock().await;
        match slot.as_ref() {
            Some(p) if p.state == state => slot.take(),
            // A link whose state matches nothing is either stale or forged. Either way it is not
            // this app's pending request, so it is not this app's business.
            _ => return,
        }
    };
    let pending = match pending {
        Some(pending) => pending,
        None => return,
    };

    if let Some(error) = error {
        emit_auth(&app, Err(format!("Google authorization failed: {error}")));
        return;
    }
    if now() > pending.expires {
        emit_auth(
            &app,
            Err("The sign-in took too long. Try connecting again.".to_string()),
        );
        return;
    }
    let code = match code {
        Some(code) => code,
        None => {
            emit_auth(&app, Err("Google returned no authorization code.".to_string()));
            return;
        }
    };

    let outcome = match load_credentials() {
        Ok(creds) => finish(&app, &creds, &code, &pending.redirect, &pending.verifier).await,
        Err(e) => Err(e),
    };
    emit_auth(&app, outcome);
}

async fn complete_auth(
    app: &tauri::AppHandle,
    listener: TcpListener,
    csrf: String,
    verifier: String,
    redirect: String,
    creds: Credentials,
) -> Result<(String, String), String> {
    let code = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
        await_code(listener, &csrf, deadline)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Nothing takes the consent page down on its own once the listener has its answer, and what it
    // is showing by then is the listener's own "you can close this" page. Taken away here rather
    // than after the exchange, and whatever the outcome was, so the app comes back the moment the
    // browser has nothing left to do. Desktop has no such surface and compiles this out.
    #[cfg(mobile)]
    crate::google::browser::close(app);

    finish(app, &creds, &code?, &redirect, &verifier).await
}

/// Code to stored account. Everything past the point where the two flows stop differing.
async fn finish(
    app: &tauri::AppHandle,
    creds: &Credentials,
    code: &str,
    redirect: &str,
    verifier: &str,
) -> Result<(String, String), String> {
    let tokens = exchange_code(creds, code, redirect, verifier).await?;
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or("Google did not return a refresh token. Remove Margin Calendar from your Google account permissions and connect again.")?;

    let claims = tokens
        .id_token
        .as_deref()
        .and_then(id_token_claims)
        .unwrap_or_default();
    let email = match claims.email {
        Some(email) if !email.is_empty() => email,
        _ => fetch_email(&tokens.access_token).await?,
    };
    // The Google user id keys everything. It falls back to the email only when the id_token is
    // missing, which should not happen while `openid` is in the scope set.
    let account_id = claims.sub.unwrap_or_else(|| email.clone());
    if account_id.is_empty() {
        return Err("Google returned neither a user id nor an email address.".to_string());
    }

    secrets::store(&account_id, &refresh)?;
    let reference = secrets::reference(&account_id);
    with_conn(app, |conn| {
        crate::store::write::upsert_account(conn, &account_id, &email, Some(&reference))
    })?;

    let state = app.state::<AuthState>();
    let mut sessions = state.sessions.lock().await;
    sessions.insert(
        account_id.clone(),
        Session {
            access_token: Some(tokens.access_token),
            access_expiry: now() + tokens.expires_in.saturating_sub(EXPIRY_SKEW_SECS),
            email: Some(email.clone()),
        },
    );

    Ok((account_id, email))
}

pub async fn disconnect(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AuthState>,
    account_id: &str,
) -> Result<(), String> {
    if let Ok(Some(refresh)) = secrets::load(account_id) {
        revoke(&refresh).await;
    }
    {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(account_id);
    }
    // Every row the account owns, not just its token. margin's disconnect cleared the token and
    // left the remote ids behind, so connecting a different account afterwards wrote against them.
    let removed = secrets::delete(account_id);
    with_conn(app, |conn| {
        crate::store::write::wipe_account(conn, account_id)
    })?;
    crate::emit_store_changed(app, "disconnect");
    removed
}

/// Single-flight: the map lock is held across the refresh await, so concurrent callers queue on
/// one token request rather than each firing their own. That serializes refreshes across accounts
/// as well, which is the right trade for something that happens once an hour per account.
pub async fn valid_access_token(
    _app: &tauri::AppHandle,
    state: &AuthState,
    account_id: &str,
) -> Result<String, String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get(account_id) {
        if let Some(token) = &session.access_token {
            if now() < session.access_expiry {
                return Ok(token.clone());
            }
        }
    }

    let refresh = secrets::load(account_id)?
        .ok_or_else(|| format!("Account {account_id} is not connected to Google."))?;
    let creds = load_credentials()?;
    let tokens = refresh_access_token(&creds, &refresh).await?;
    if let Some(rotated) = &tokens.refresh_token {
        if rotated != &refresh {
            secrets::store(account_id, rotated)?;
        }
    }

    let session = sessions.entry(account_id.to_string()).or_default();
    session.access_token = Some(tokens.access_token.clone());
    session.access_expiry = now() + tokens.expires_in.saturating_sub(EXPIRY_SKEW_SECS);
    Ok(tokens.access_token)
}

/// The token store needs a directory and the sessions map wants the stored emails, both of which
/// are only knowable once the app is up.
pub fn init_sessions(app: &tauri::AppHandle) {
    if let Ok(dir) = crate::library::app_data_dir(app) {
        secrets::init(dir);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let accounts = match with_conn(&app, crate::store::read::accounts) {
            Ok(accounts) => accounts,
            Err(_) => return,
        };
        let state = app.state::<AuthState>();
        let mut sessions = state.sessions.lock().await;
        for account in accounts {
            sessions.entry(account.id).or_default().email = Some(account.email);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_rfc7636_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_verifier_is_url_safe_and_unpadded() {
        let verifier = random_b64(64);
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn request_path_reads_the_target_of_the_request_line() {
        let request = "GET /?code=abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(request_path(request), "/?code=abc");
        assert_eq!(request_path(""), "");
    }

    #[test]
    fn a_matching_state_yields_the_code() {
        assert_eq!(
            parse_redirect("/?code=4%2F0Ab&state=xyz&scope=openid", "xyz"),
            Redirect::Code("4/0Ab".to_string())
        );
    }

    #[test]
    fn a_foreign_state_is_rejected_rather_than_exchanged() {
        assert_eq!(parse_redirect("/?code=4/0Ab&state=other", "xyz"), Redirect::Mismatch);
        assert_eq!(parse_redirect("/?code=4/0Ab", "xyz"), Redirect::Mismatch);
    }

    #[test]
    fn a_denial_carries_googles_reason() {
        assert_eq!(
            parse_redirect("/?error=access_denied&state=xyz", "xyz"),
            Redirect::Denied("access_denied".to_string())
        );
    }

    #[test]
    fn incidental_requests_keep_the_listener_waiting() {
        assert_eq!(parse_redirect("/favicon.ico", "xyz"), Redirect::Waiting);
        assert_eq!(parse_redirect("/", "xyz"), Redirect::Waiting);
        assert_eq!(parse_redirect("", "xyz"), Redirect::Waiting);
    }

    #[test]
    fn id_token_claims_reads_the_subject_and_email() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"11829","email":"a@b.test","aud":"x"}"#);
        let claims = id_token_claims(&format!("header.{payload}.signature")).expect("claims");
        assert_eq!(claims.sub.as_deref(), Some("11829"));
        assert_eq!(claims.email.as_deref(), Some("a@b.test"));
    }

    #[test]
    fn a_malformed_id_token_is_none_rather_than_a_panic() {
        assert!(id_token_claims("not-a-jwt").is_none());
        assert!(id_token_claims("header..signature").is_none());
    }
}
