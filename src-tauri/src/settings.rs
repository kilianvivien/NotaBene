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
//! file never leaves this machine and is `0600`. Keeping them apart means an
//! accidental "attach your settings" can never carry a key.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;

const SETTINGS_FILE: &str = "settings.json";
const SECRETS_FILE: &str = "secrets.json";

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
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

/// A `0600` file in the app data dir, addressed by provider id.
///
/// Phase E moves this to the macOS Keychain behind the same commands; the
/// interface is already the boundary, so that is a change here and nowhere
/// else. Until then the file is still outside every path that produces a
/// backup or an export — `LibrarySchema` has no field a key could occupy.
fn read_secrets(app: &AppHandle) -> Result<BTreeMap<String, String>> {
    let path = data_dir(app)?.join(SECRETS_FILE);
    match read_json(&path)? {
        Some(value) => serde_json::from_value(value).map_err(|error| error.to_string()),
        None => Ok(BTreeMap::new()),
    }
}

fn write_secrets(app: &AppHandle, secrets: &BTreeMap<String, String>) -> Result<()> {
    let path = data_dir(app)?.join(SECRETS_FILE);
    let contents = serde_json::to_string(secrets).map_err(|error| error.to_string())?;
    write_atomic(&path, &contents, true)
}

#[tauri::command]
pub fn secrets_get(app: AppHandle, key: String) -> Result<Option<String>> {
    Ok(read_secrets(&app)?.get(&key).cloned())
}

#[tauri::command]
pub fn secrets_set(app: AppHandle, key: String, value: String) -> Result<()> {
    let mut secrets = read_secrets(&app)?;
    secrets.insert(key, value);
    write_secrets(&app, &secrets)
}

#[tauri::command]
pub fn secrets_remove(app: AppHandle, key: String) -> Result<()> {
    let mut secrets = read_secrets(&app)?;
    secrets.remove(&key);
    write_secrets(&app, &secrets)
}

/// Key names only. Settings can show which providers are configured without a
/// single secret value crossing into the webview.
#[tauri::command]
pub fn secrets_list_keys(app: AppHandle) -> Result<Vec<String>> {
    Ok(read_secrets(&app)?.into_keys().collect())
}
