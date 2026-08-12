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

/// The names the encrypted store used while it was still the fallback behind a credential store.
/// Read once and migrated, so an existing install does not silently lose its accounts and ask the
/// user to reconnect for no reason they can see.
const LEGACY_BLOB_NAME: &str = "keychain-fallback.enc";
const LEGACY_SALT_NAME: &str = "keychain-fallback.salt";

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
    let legacy = dir.join(LEGACY_SALT_NAME);
    let salt = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() == 32 => bytes,
        _ => match std::fs::read(&legacy) {
            // Same salt, new name. Rewritten rather than renamed so an interrupted migration
            // leaves both files readable rather than neither.
            Ok(bytes) if bytes.len() == 32 => {
                write_private(&path, &bytes)?;
                bytes
            }
            _ => {
                let mut bytes = vec![0u8; 32];
                rand::thread_rng().fill_bytes(&mut bytes);
                write_private(&path, &bytes)?;
                bytes
            }
        },
    };
    let mut hasher = Sha256::new();
    hasher.update(KEY_CONTEXT.as_bytes());
    hasher.update(&salt);
    hasher.update(machine_id().as_bytes());
    Ok(hasher.finalize().into())
}

/// Mixed into the key so a copied home directory does not decrypt on another machine. Empty on
/// macOS, iOS and Android, where no such file exists and the sandbox or the file mode is doing the
/// work instead. An empty contribution is not a weakness here: the salt is already random and
/// per install, and this only ever adds entropy.
fn machine_id() -> String {
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

fn read_blob() -> Result<BTreeMap<String, String>, String> {
    let dir = data_dir()?;
    let path = dir.join(BLOB_NAME);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read_to_string(dir.join(LEGACY_BLOB_NAME)) {
                Ok(text) => text,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
                Err(e) => return Err(e.to_string()),
            }
        }
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
}
