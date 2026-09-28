//! App settings and secrets on disk.
//!
//! Settings stay opaque JSON on this side on purpose. Their shape is a
//! TypeScript contract (`SettingsAdapter.ts`) and nothing in Rust reads a field
//! of it, so giving the shell a second definition would only create something
//! to drift. What this module does own is *where* the two files live and what
//! permissions they carry — which is the part the webview cannot be trusted
//! with.
//!
//! The split between the two files is the same one the interfaces make: a
//! settings file is ordinary JSON that may appear in a diagnostic, a secrets
//! file never leaves this machine. Keeping them apart means an accidental
//! "attach your settings" can never carry a key.
//!
//! Secret *values* live in the login Keychain on macOS (Phase E); everywhere
//! else, and if the Keychain is unreachable, they fall back to a `0600` file.
//! Either way the webview only ever sees a value it asked for by name.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;

const SETTINGS_FILE: &str = "settings.json";
const SECRETS_FILE: &str = "secrets.json";
/// Names only — the file this index lives in holds no values, so it is not a
/// secret and does not need the Keychain round trip that listing would
/// otherwise require. (`security dump-keychain` prompts per item; a Settings
/// pane that asks for your password to draw a checkmark is not shippable.)
const SECRET_INDEX_FILE: &str = "secret-keys.json";

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// The one setting Rust needs before the webview exists. Everything else stays
/// opaque on this side; the library location is different because SQLite and
/// the cross-machine lock have to open before TypeScript can migrate settings.
pub(crate) fn configured_library_location(app: &AppHandle) -> Result<Option<PathBuf>> {
    let path = data_dir(app)?.join(SETTINGS_FILE);
    let Some(value) = read_json(&path)? else {
        return Ok(None);
    };
    let Some(location) = value.get("libraryLocation") else {
        return Ok(None);
    };
    if location.is_null() {
        return Ok(None);
    }
    let location = location
        .as_str()
        .ok_or_else(|| "libraryLocation must be a path or null".to_string())?;
    let path = PathBuf::from(location);
    if !path.is_absolute() {
        return Err("libraryLocation must be an absolute path".into());
    }
    Ok(Some(path))
}

/// Write through a temporary file and rename over the target.
///
/// A settings file truncated by a crash mid-write would read as "no settings"
/// on the next launch, silently resetting the user's preferences. The rename is
/// atomic, so the old file stands until the new one is complete.
fn write_atomic(path: &Path, contents: &str, private: bool) -> Result<()> {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;

    if private {
        restrict_permissions(&temporary)?;
    }

    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn read_json(path: &Path) -> Result<Option<Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

// -- settings ----------------------------------------------------------------

/// Missing file means "nothing saved yet", not an error: the TypeScript side
/// merges whatever comes back over `DEFAULT_SETTINGS`.
#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Value> {
    let path = data_dir(&app)?.join(SETTINGS_FILE);
    Ok(read_json(&path)?.unwrap_or_else(|| Value::Object(Default::default())))
}

#[tauri::command]
pub fn settings_save(app: AppHandle, settings: Value) -> Result<()> {
    let path = data_dir(&app)?.join(SETTINGS_FILE);
    let contents = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    write_atomic(&path, &contents, false)
}

// -- secrets -----------------------------------------------------------------

/// Keychain service name. One service, one account per secret key, so a user
/// can see and revoke NotaBene's entries in Keychain Access as a group.
const KEYCHAIN_SERVICE: &str = "app.notabene.desktop";

/// Reject anything that could be read as an argument rather than an account
/// name. `security` takes its account after `-a`, so a leading dash is the
/// whole attack surface; keys are provider ids and never look like this.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with('-')
        // Quoted inside `security -i`'s command line, where these two would
        // end the quote or escape out of it.
        && !key.contains(|c: char| c.is_control() || c == '"' || c == '\\')
}

/// Whether secret values can go to the Keychain on this machine.
///
/// The `security` CLI rather than a Keychain crate: it is present on every
/// macOS install, it needs no new dependency in a security-sensitive place,
/// and it is the same tool a user would reach for to audit what we stored.
#[cfg(target_os = "macos")]
fn keychain_available() -> bool {
    std::path::Path::new("/usr/bin/security").exists()
}

#[cfg(not(target_os = "macos"))]
fn keychain_available() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::{Result, KEYCHAIN_SERVICE};
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn run(args: &[&str]) -> Result<std::process::Output> {
        Command::new("/usr/bin/security")
            .args(args)
            .output()
            .map_err(|error| error.to_string())
    }

    pub fn get(key: &str) -> Result<Option<String>> {
        let output = run(&[
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            key,
            "-w",
        ])?;
        if !output.status.success() {
            // A missing item and a locked keychain both exit non-zero. Treating
            // both as "not set" is right for the caller: either way there is no
            // key to use, and the user's next move is to paste one in.
            return Ok(None);
        }
        let value = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        Ok(Some(value))
    }

    /// `-U` updates in place, so re-pasting a rotated key does not leave the
    /// old item behind for `find` to return at random.
    pub fn set(key: &str, value: &str) -> Result<()> {
        set_in(KEYCHAIN_SERVICE, key, value)
    }

    /// The command travels on stdin to `security -i`, never on its argv:
    /// arguments are readable by every user on the Mac through `ps` for as
    /// long as the process lives, and `-w <key>` put the API key there. The
    /// value goes as `-X` hex, so nothing in it — quotes, backslashes, spaces
    /// — can change how the command line is read.
    pub(super) fn set_in(service: &str, key: &str, value: &str) -> Result<()> {
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        let hex: String = value.bytes().map(|byte| format!("{byte:02x}")).collect();
        let command = format!("add-generic-password -s \"{service}\" -a \"{key}\" -X {hex} -U\n");
        {
            let mut stdin = child.stdin.take().ok_or("security stdin unavailable")?;
            stdin
                .write_all(command.as_bytes())
                .map_err(|error| error.to_string())?;
            // Dropped here: EOF is what ends the interactive session.
        }
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    #[cfg(test)]
    pub(super) fn get_in(service: &str, key: &str) -> Result<Option<String>> {
        let output = run(&["find-generic-password", "-s", service, "-a", key, "-w"])?;
        Ok(output.status.success().then(|| {
            String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_string()
        }))
    }

    #[cfg(test)]
    pub(super) fn remove_in(service: &str, key: &str) {
        let _ = run(&["delete-generic-password", "-s", service, "-a", key]);
    }

    pub fn remove(key: &str) -> Result<()> {
        // Deleting something that is not there is success, not failure.
        run(&["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key])?;
        Ok(())
    }
}

/// The `0600` fallback, used off macOS and when `security` is unavailable.
///
/// Still outside every path that produces a backup or an export —
/// `LibrarySchema` has no field a key could occupy.
fn read_secret_file(app: &AppHandle) -> Result<BTreeMap<String, String>> {
    let path = data_dir(app)?.join(SECRETS_FILE);
    match read_json(&path)? {
        Some(value) => serde_json::from_value(value).map_err(|error| error.to_string()),
        None => Ok(BTreeMap::new()),
    }
}

fn write_secret_file(app: &AppHandle, secrets: &BTreeMap<String, String>) -> Result<()> {
    let path = data_dir(app)?.join(SECRETS_FILE);
    let contents = serde_json::to_string(secrets).map_err(|error| error.to_string())?;
    write_atomic(&path, &contents, true)
}

fn read_index(app: &AppHandle) -> Result<Vec<String>> {
    let path = data_dir(app)?.join(SECRET_INDEX_FILE);
    match read_json(&path)? {
        Some(value) => serde_json::from_value(value).map_err(|error| error.to_string()),
        None => Ok(Vec::new()),
    }
}

fn write_index(app: &AppHandle, keys: &[String]) -> Result<()> {
    let path = data_dir(app)?.join(SECRET_INDEX_FILE);
    let contents = serde_json::to_string(keys).map_err(|error| error.to_string())?;
    write_atomic(&path, &contents, false)
}

// The platform split happens exactly here. Everything below these three
// functions is storage-agnostic.

#[cfg(target_os = "macos")]
fn store_get(app: &AppHandle, key: &str) -> Result<Option<String>> {
    if keychain_available() {
        return keychain::get(key);
    }
    Ok(read_secret_file(app)?.get(key).cloned())
}

#[cfg(not(target_os = "macos"))]
fn store_get(app: &AppHandle, key: &str) -> Result<Option<String>> {
    Ok(read_secret_file(app)?.get(key).cloned())
}

#[cfg(target_os = "macos")]
fn store_set(app: &AppHandle, key: &str, value: &str) -> Result<()> {
    if keychain_available() {
        return keychain::set(key, value);
    }
    let mut secrets = read_secret_file(app)?;
    secrets.insert(key.to_string(), value.to_string());
    write_secret_file(app, &secrets)
}

#[cfg(not(target_os = "macos"))]
fn store_set(app: &AppHandle, key: &str, value: &str) -> Result<()> {
    let mut secrets = read_secret_file(app)?;
    secrets.insert(key.to_string(), value.to_string());
    write_secret_file(app, &secrets)
}

#[cfg(target_os = "macos")]
fn store_remove(app: &AppHandle, key: &str) -> Result<()> {
    if keychain_available() {
        return keychain::remove(key);
    }
    let mut secrets = read_secret_file(app)?;
    secrets.remove(key);
    write_secret_file(app, &secrets)
}

#[cfg(not(target_os = "macos"))]
fn store_remove(app: &AppHandle, key: &str) -> Result<()> {
    let mut secrets = read_secret_file(app)?;
    secrets.remove(key);
    write_secret_file(app, &secrets)
}

/// Move any keys left in the `0600` file into the Keychain, once.
///
/// Phase A shipped the file; Phase E promises the Keychain. A user who pasted a
/// key before this change should not have to paste it again, and the file
/// should not linger holding a copy of a secret that now lives somewhere
/// better. Called from the Tauri setup hook, and a no-op everywhere else.
pub fn migrate_secrets(app: &AppHandle) -> Result<()> {
    if !keychain_available() {
        return Ok(());
    }
    let existing = read_secret_file(app)?;
    if existing.is_empty() {
        return Ok(());
    }

    let mut keys = read_index(app)?;
    for (key, value) in &existing {
        if !valid_key(key) {
            continue;
        }
        store_set(app, key, value)?;
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    keys.sort();
    write_index(app, &keys)?;

    // Only now, with every value safely re-homed, does the old copy go.
    let path = data_dir(app)?.join(SECRETS_FILE);
    std::fs::remove_file(&path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secrets_get(app: AppHandle, key: String) -> Result<Option<String>> {
    if !valid_key(&key) {
        return Err(format!("invalid secret key \"{key}\""));
    }
    store_get(&app, &key)
}

#[tauri::command]
pub fn secrets_set(app: AppHandle, key: String, value: String) -> Result<()> {
    if !valid_key(&key) {
        return Err(format!("invalid secret key \"{key}\""));
    }
    store_set(&app, &key, &value)?;

    let mut keys = read_index(&app)?;
    if !keys.contains(&key) {
        keys.push(key);
        keys.sort();
        write_index(&app, &keys)?;
    }
    Ok(())
}

#[tauri::command]
pub fn secrets_remove(app: AppHandle, key: String) -> Result<()> {
    if !valid_key(&key) {
        return Err(format!("invalid secret key \"{key}\""));
    }
    store_remove(&app, &key)?;

    let mut keys = read_index(&app)?;
    keys.retain(|entry| entry != &key);
    write_index(&app, &keys)
}

/// Key names only. Settings can show which providers are configured without a
/// single secret value crossing into the webview.
#[tauri::command]
pub fn secrets_list_keys(app: AppHandle) -> Result<Vec<String>> {
    let indexed = read_index(&app)?;
    if !indexed.is_empty() {
        return Ok(indexed);
    }
    // Nothing indexed: either nothing is stored, or this is a library written
    // before the index existed. The fallback file answers both.
    Ok(read_secret_file(&app)?.into_keys().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_name_cannot_become_an_argument_or_break_its_quotes() {
        assert!(valid_key("ai.anthropic"));
        for bad in ["", "-w", "a\"b", "a\\b", "a\nb"] {
            assert!(!valid_key(bad), "{bad:?} should be refused");
        }
    }

    /// Against the real login keychain, under a throwaway service name:
    /// `cargo test -- --ignored keychain_round_trips`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes a throwaway item to the login keychain"]
    fn keychain_round_trips_a_value_that_would_break_a_command_line() {
        const SERVICE: &str = "app.notabene.desktop.selftest";
        let key = "provider:self test";
        let value = "sk-ant \"quoted\" \\ back -U -w";
        keychain::remove_in(SERVICE, key);
        keychain::set_in(SERVICE, key, value).expect("set");
        assert_eq!(
            keychain::get_in(SERVICE, key).unwrap().as_deref(),
            Some(value)
        );
        // `-U` replaces rather than duplicating.
        keychain::set_in(SERVICE, key, "rotated").expect("update");
        assert_eq!(
            keychain::get_in(SERVICE, key).unwrap().as_deref(),
            Some("rotated")
        );
        keychain::remove_in(SERVICE, key);
        assert_eq!(keychain::get_in(SERVICE, key).unwrap(), None);
    }
}
