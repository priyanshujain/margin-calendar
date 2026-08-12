// Where refresh tokens live: an encrypted file in the app's data directory, on every platform.
// Never plaintext on disk, never in the SQLite store, one entry per account id.
//
// This used to be the OS credential store with this file as a fallback, and that is gone. The
// credential stores did not survive contact with five platforms:
//
//   macOS    Keychain ties an item's ACL to the code signature, so an ad-hoc signed build gets a
//            new identity on every compile and macOS correctly re-asks for authorization every
//            single time. An authorization dialog a minute is not something to ask anyone to live
//            with, so macOS was already excluded before mobile came up at all.
//   Android  The keyring crate has no Android backend. There is nothing to fall back from.
//   Linux    A minimal window manager often runs no Secret Service daemon, so the fallback ran
//            anyway on exactly the machines that most wanted the daemon.
//
// That left one real implementation and four ways of reaching it, so the branching went and the
// file stayed. Be clear about what it is worth, because it is not the same everywhere:
//
//   iOS, Android  The app sandbox is the boundary. Another app cannot read this file, so the
//                 encryption is defence in depth over a boundary the OS already enforces.
//   Desktop       Anyone who can read the user's home directory can read the token. The key is
//                 derived from a salt sitting next to the ciphertext, mixed with a machine
//                 identifier, so a copied home directory does not decrypt elsewhere, and that is
//                 the whole of the protection. Better than plaintext, worse than the Secret
//                 Service, and chosen knowing that.
//
// The token is a Google refresh token scoped to one calendar account, revocable from the user's
// Google account page, and revoked here on disconnect.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const SERVICE: &str = "studio.margin.calendar";

const BLOB_NAME: &str = "tokens.enc";
const SALT_NAME: &str = "tokens.salt";
const KEY_CONTEXT: &str = "margin-calendar token store v1";
const NONCE_LEN: usize = 24;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called from `auth::init_sessions` during setup, before any command can run, because this needs
/// a directory and the signatures below deliberately do not carry an AppHandle.
pub fn init(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// The reference stored in the `accounts` row. It names the entry, never the secret.
///
/// The column is still called `keychain_ref` because renaming it would cost a migration and buy
/// nothing: it has only ever held this string.
pub fn reference(account_id: &str) -> String {
    format!("{SERVICE}/{account_id}")
}

pub fn store(account_id: &str, refresh_token: &str) -> Result<(), String> {
    let sealed = seal(&key()?, refresh_token.as_bytes())?;
    let mut entries = read_blob()?;
    entries.insert(account_id.to_string(), sealed);
    write_blob(&entries)
}

pub fn load(account_id: &str) -> Result<Option<String>, String> {
    let entries = read_blob()?;
    let sealed = match entries.get(account_id) {
        Some(sealed) => sealed,
        None => return Ok(None),
    };
    let plain = open(&key()?, sealed)?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "the stored token is not valid UTF-8".to_string())
}

pub fn delete(account_id: &str) -> Result<(), String> {
    let mut entries = read_blob()?;
    if entries.remove(account_id).is_none() {
        return Ok(());
    }
    write_blob(&entries)
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = DATA_DIR.get() {
        return Ok(dir.clone());
    }
    // Only reachable before setup has run, which on mobile is never: there is no XDG layout to
    // guess at there, so the honest answer is the error rather than a path that does not exist.
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or("no app data directory is known")?;
    let dir = base.join(SERVICE);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The salt is per install and random. Losing it means losing every stored token, which costs a
/// reconnect and nothing else, so it is written once and never rotated.
fn key() -> Result<[u8; 32], String> {
    let dir = data_dir()?;
    let path = dir.join(SALT_NAME);
    let salt = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() == 32 => bytes,
        // Absent, or too short to be a salt because a previous write was cut off. Neither case has
        // a salt worth keeping, so there is nothing for a fresh one to destroy.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fresh_salt(&path)?,
        Ok(_) => fresh_salt(&path)?,
        // A salt that exists and will not read is a different thing entirely, and writing over it
        // would turn one transient failure into the permanent loss of every stored token. Refuse.
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut hasher = Sha256::new();
    hasher.update(KEY_CONTEXT.as_bytes());
    hasher.update(&salt);
    hasher.update(machine_id().as_bytes());
    Ok(hasher.finalize().into())
}

fn fresh_salt(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    write_private(path, &bytes)?;
    Ok(bytes)
}

/// Mixed into the key so a copied home directory does not decrypt on another machine. The salt
/// sits next to the ciphertext and the context below is a constant in a public binary, so this is
/// the only thing binding a stored token to the machine it was stored on. An empty one is not a
/// neutral contribution of no entropy, it is the absence of the binding, and a home directory
/// lifted off that machine decrypts anywhere.
///
/// Deliberately empty on iOS and Android even so. The sandbox is the real boundary there, and the
/// identifiers those platforms offer are reset by a reinstall, which would lock a user out of a
/// token that was never in any danger.
///
/// Read once. On macOS it costs a process, and `key()` runs on every load and every store.
fn machine_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(read_machine_id).as_str()
}

#[cfg(target_os = "linux")]
fn read_machine_id() -> String {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = std::fs::read_to_string(path) {
            let id = id.trim();
            if !id.is_empty() {
                return id.to_string();
            }
        }
    }
    String::new()
}

/// `ioreg` rather than an IOKit binding, because it is a stock binary at a fixed path and one
/// process at first use is a better trade than a core-foundation dependency for one string. The
/// absolute path is not decoration: an app launched from Finder inherits a minimal environment.
///
/// `IOPlatformUUID` is stable across reboots and OS upgrades and changes with the logic board, so
/// a repaired Mac reconnects its accounts. That is the same cost as losing the salt, and the right
/// answer for the case this defends: a home directory restored onto different hardware.
#[cfg(target_os = "macos")]
fn read_machine_id() -> String {
    let output = match std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
    {
        Ok(output) if output.status.success() => output.stdout,
        // An empty id still derives a working key, it only stops binding the token to this Mac.
        // Failing here instead would lock the user out of a token that is perfectly good.
        _ => return String::new(),
    };
    String::from_utf8_lossy(&output)
        .lines()
        .find_map(|line| {
            let (_, rest) = line.split_once("\"IOPlatformUUID\"")?;
            let (_, rest) = rest.split_once('"')?;
            let (uuid, _) = rest.split_once('"')?;
            Some(uuid.to_string())
        })
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_machine_id() -> String {
    String::new()
}

fn read_blob() -> Result<BTreeMap<String, String>, String> {
    let dir = data_dir()?;
    let path = dir.join(BLOB_NAME);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn write_blob(entries: &BTreeMap<String, String>) -> Result<(), String> {
    let path = data_dir()?.join(BLOB_NAME);
    let text = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    write_private(&path, text.as_bytes())
}

fn seal(key_bytes: &[u8; 32], plain: &[u8]) -> Result<String, String> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key_bytes));
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut sealed = cipher
        .encrypt(XNonce::from_slice(&nonce), plain)
        .map_err(|_| "could not encrypt the token".to_string())?;
    let mut out = nonce.to_vec();
    out.append(&mut sealed);
    Ok(BASE64.encode(out))
}

fn open(key_bytes: &[u8; 32], sealed: &str) -> Result<Vec<u8>, String> {
    let raw = BASE64
        .decode(sealed)
        .map_err(|e| format!("the stored token is malformed: {e}"))?;
    if raw.len() <= NONCE_LEN {
        return Err("the stored token is truncated".to_string());
    }
    let (nonce, body) = raw.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key_bytes));
    cipher
        .decrypt(XNonce::from_slice(nonce), body)
        .map_err(|_| "the stored token could not be decrypted on this machine".to_string())
}

/// Written 0600 from creation rather than chmodded after the fact, so the ciphertext is never
/// briefly world readable. The mode is a no-op on the mobile sandboxes and costs nothing there.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_tokens_round_trip() {
        let key = [7u8; 32];
        let sealed = seal(&key, b"1//refresh-token").expect("seal");
        assert_eq!(open(&key, &sealed).expect("open"), b"1//refresh-token");
    }

    #[test]
    fn a_different_key_does_not_open_the_token() {
        let sealed = seal(&[7u8; 32], b"1//refresh-token").expect("seal");
        assert!(open(&[8u8; 32], &sealed).is_err());
    }

    #[test]
    fn each_seal_uses_a_fresh_nonce() {
        let key = [7u8; 32];
        assert_ne!(
            seal(&key, b"same").expect("seal"),
            seal(&key, b"same").expect("seal")
        );
    }

    #[test]
    fn a_truncated_blob_is_rejected_rather_than_panicking() {
        assert!(open(&[7u8; 32], &BASE64.encode([0u8; 8])).is_err());
    }

    #[test]
    fn a_tampered_blob_is_rejected_rather_than_returning_plaintext() {
        let key = [7u8; 32];
        let sealed = seal(&key, b"1//refresh-token").expect("seal");
        let mut raw = BASE64.decode(&sealed).expect("decode");
        // Past the nonce, so it is the ciphertext that changed and the tag that catches it.
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert!(open(&key, &BASE64.encode(raw)).is_err());
    }

    #[test]
    fn a_reference_names_the_entry_and_never_the_secret() {
        assert_eq!(reference("1234"), "studio.margin.calendar/1234");
    }

    /// The point of the machine id is that a copied home directory does not decrypt elsewhere, and
    /// the salt travels with the copy. An empty id on a desktop means that protection is not there
    /// at all, which is what macOS did before it learned to read `IOPlatformUUID`.
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn a_desktop_binds_the_key_to_the_machine() {
        assert!(
            !machine_id().is_empty(),
            "no machine id, so a copied home directory would decrypt anywhere"
        );
    }

    /// Reading it twice must agree, or a token sealed early in a run stops opening later in it.
    #[test]
    fn the_machine_id_is_stable_within_a_run() {
        assert_eq!(machine_id(), machine_id());
    }

    /// The round trip the app performs, through the real salt file and the real machine id, rather
    /// than the constant key the tests above hand to `seal` directly. This is the path a sign-in
    /// takes, and every derivation in it has to agree with every other or a token survives only
    /// the call that wrote it.
    ///
    /// The only test that touches `DATA_DIR`, which is set once per process and never reset.
    #[test]
    fn a_stored_token_comes_back_out() {
        let dir = std::env::temp_dir().join(format!("margin-calendar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        init(dir.clone());

        store("account", "1//refresh-token").expect("store");
        assert_eq!(
            load("account").expect("load").as_deref(),
            Some("1//refresh-token")
        );
        // Again, because the second call derives the key afresh from the salt now on disk.
        assert_eq!(
            load("account").expect("load").as_deref(),
            Some("1//refresh-token")
        );

        delete("account").expect("delete");
        assert_eq!(load("account").expect("load"), None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
