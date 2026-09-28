//! Paths the student chose in a native panel — the only paths the webview can
//! name to a command that reads, writes or moves files outside NotaBene's own
//! folders.
//!
//! `folder_import.rs` established the rule for the importers; this module is
//! the same rule for everything else (security review 2026-09, items 10–11).
//! Every panel opens from Rust and records what came back. `export_write`,
//! `backups_read`, `backups_list` and `library_relocate` then accept a path
//! only when it is:
//!
//! - a file the student picked or saved to in a panel this session, or
//! - under a folder NotaBene owns — its exports folder or its backups
//!   folder — or
//! - under the backup folder the student chose, the one grant that has to
//!   outlive a relaunch.
//!
//! That last grant is kept in `granted-folders.json`, written only here. It
//! deliberately does not live in `settings.json`: the webview writes settings,
//! and a grant it could write for itself would be no grant at all.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

const GRANTS_FILE: &str = "granted-folders.json";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGrants {
    backup_folders: Vec<PathBuf>,
}

#[derive(Default)]
pub struct Grants {
    /// Files picked in an open or save panel this session.
    files: Mutex<HashSet<PathBuf>>,
    /// Folders picked this session, for relocating the library.
    folders: Mutex<HashSet<PathBuf>>,
    /// Folders chosen for backups, kept across launches.
    backup_folders: Mutex<HashSet<PathBuf>>,
}

/// A path as it will be compared: canonical where it exists, and for a file
/// that does not exist yet (a save target), its canonical parent plus its
/// name. `None` when not even the parent exists.
fn normalize(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Some(canonical);
    }
    let parent = std::fs::canonicalize(path.parent()?).ok()?;
    Some(parent.join(path.file_name()?))
}

/// NotaBene's own folders: the exports folder MCP writes into, and the
/// managed backups folder. Created on demand, like their commands do.
fn owned_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(backups) = crate::db::backups_path(app) {
        roots.push(backups);
    }
    if let Ok(downloads) = app.path().download_dir() {
        roots.push(downloads.join("NotaBene exports"));
    }
    roots
        .into_iter()
        .filter_map(|root| {
            std::fs::create_dir_all(&root).ok()?;
            std::fs::canonicalize(root).ok()
        })
        .collect()
}

impl Grants {
    /// Load the persisted backup folder, seeding it once from the setting a
    /// build before this rule wrote — that folder was chosen in a panel, and
    /// making the student choose it again would break their backups silently.
    pub fn load(app: &AppHandle) -> Self {
        let grants = Grants::default();
        let Ok(dir) = crate::settings::data_dir(app) else {
            return grants;
        };
        let path = dir.join(GRANTS_FILE);
        let persisted = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<PersistedGrants>(&text).unwrap_or_default(),
            Err(_) => {
                let legacy = std::fs::read_to_string(dir.join("settings.json"))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .and_then(|settings| {
                        settings
                            .get("backupFolder")
                            .and_then(Value::as_str)
                            .map(PathBuf::from)
                    });
                let seeded = PersistedGrants {
                    backup_folders: legacy.into_iter().filter_map(|p| normalize(&p)).collect(),
                };
                let _ = write_persisted(&path, &seeded);
                seeded
            }
        };
        if let Ok(mut folders) = grants.backup_folders.lock() {
            folders.extend(persisted.backup_folders);
        }
        grants
    }

    fn grant_backup_folder(&self, app: &AppHandle, folder: PathBuf) -> Result<(), String> {
        let mut folders = self
            .backup_folders
            .lock()
            .map_err(|_| "grants poisoned".to_string())?;
        folders.insert(folder);
        let persisted = PersistedGrants {
            backup_folders: folders.iter().cloned().collect(),
        };
        let path = crate::settings::data_dir(app)?.join(GRANTS_FILE);
        write_persisted(&path, &persisted)
    }

    fn picked_file(&self, path: &Path) -> bool {
        self.files
            .lock()
            .map(|files| files.contains(path))
            .unwrap_or(false)
    }

    fn under_backup_folder(&self, path: &Path) -> bool {
        self.backup_folders
            .lock()
            .map(|folders| folders.iter().any(|folder| path.starts_with(folder)))
            .unwrap_or(false)
    }

    /// Where `export_write` may put a file: a save-panel answer, or anywhere
    /// under an owned folder or the chosen backup folder.
    pub fn writable(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize(path).ok_or_else(refused)?;
        let allowed = self.picked_file(&normalized)
            || self.under_backup_folder(&normalized)
            || owned_roots(app)
                .iter()
                .any(|root| normalized.starts_with(root));
        allowed.then_some(normalized).ok_or_else(refused)
    }

    /// What `backups_read` may open: the same places, since every backup it
    /// reads was either written to one of them or picked in a panel.
    pub fn readable_backup(&self, app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
        self.writable(app, path)
    }

    /// A folder `backups_list` may enumerate.
    pub fn listable(&self, folder: &Path) -> Result<PathBuf, String> {
        let normalized = normalize(folder).ok_or_else(refused)?;
        let granted = self
            .backup_folders
            .lock()
            .map(|folders| folders.contains(&normalized))
            .unwrap_or(false);
        granted.then_some(normalized).ok_or_else(refused)
    }

    /// A destination `library_relocate` may move the library into.
    pub fn relocatable(&self, folder: &Path) -> Result<PathBuf, String> {
        let normalized = normalize(folder).ok_or_else(refused)?;
        let granted = self
            .folders
            .lock()
            .map(|folders| folders.contains(&normalized))
            .unwrap_or(false);
        granted.then_some(normalized).ok_or_else(refused)
    }
}

fn refused() -> String {
    "NOT_PICKED: only a location chosen in a NotaBene panel can be used".into()
}

fn write_persisted(path: &Path, grants: &PersistedGrants) -> Result<(), String> {
    let text = serde_json::to_string_pretty(grants).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

fn with_filters<R: tauri::Runtime>(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<R>,
    filters: &[DialogFilter],
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &extensions);
    }
    builder
}

/// Open panel. Picked files join the session's grants and the webview's
/// read scope — the one place that scope is widened.
#[tauri::command]
pub async fn dialog_pick_files(
    app: AppHandle,
    filters: Vec<DialogFilter>,
    multiple: bool,
) -> Result<Vec<String>, String> {
    let panel = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let builder = with_filters(panel.dialog().file(), &filters);
        if multiple {
            builder.blocking_pick_files().unwrap_or_default()
        } else {
            builder.blocking_pick_file().into_iter().collect()
        }
    })
    .await
    .map_err(|error| error.to_string())?;

    let grants = app.state::<Grants>();
    let mut out = Vec::new();
    for file in picked {
        let path = file.into_path().map_err(|error| error.to_string())?;
        let Some(normalized) = normalize(&path) else {
            continue;
        };
        app.fs_scope()
            .allow_file(&normalized)
            .map_err(|error| error.to_string())?;
        grants
            .files
            .lock()
            .map_err(|_| "grants poisoned".to_string())?
            .insert(normalized.clone());
        out.push(normalized.to_string_lossy().into_owned());
    }
    Ok(out)
}

/// Save panel. The answer is the one path `export_write` may create outside
/// NotaBene's own folders. `default_path` is a suggestion the student sees and
/// can change; it grants nothing by itself.
#[tauri::command]
pub async fn dialog_pick_save(
    app: AppHandle,
    default_path: Option<String>,
    filters: Vec<DialogFilter>,
) -> Result<Option<String>, String> {
    let panel = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = with_filters(panel.dialog().file(), &filters);
        if let Some(suggested) = default_path.as_deref().map(Path::new) {
            if let Some(name) = suggested.file_name() {
                builder = builder.set_file_name(name.to_string_lossy());
            }
            if let Some(directory) = suggested.parent().filter(|dir| dir.is_dir()) {
                builder = builder.set_directory(directory);
            }
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;

    let Some(file) = picked else { return Ok(None) };
    let path = file.into_path().map_err(|error| error.to_string())?;
    let normalized = normalize(&path).ok_or_else(refused)?;
    app.state::<Grants>()
        .files
        .lock()
        .map_err(|_| "grants poisoned".to_string())?
        .insert(normalized.clone());
    Ok(Some(normalized.to_string_lossy().into_owned()))
}

/// Folder panel. `backup` makes the answer the backup folder, kept across
/// launches; anything else grants it for this session (relocation).
#[tauri::command]
pub async fn dialog_pick_folder(
    app: AppHandle,
    grants: State<'_, Grants>,
    purpose: Option<String>,
) -> Result<Option<String>, String> {
    let panel = app.clone();
    let picked =
        tauri::async_runtime::spawn_blocking(move || panel.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| error.to_string())?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let path = folder.into_path().map_err(|error| error.to_string())?;
    let normalized = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if purpose.as_deref() == Some("backup") {
        grants.grant_backup_folder(&app, normalized.clone())?;
    }
    grants
        .folders
        .lock()
        .map_err(|_| "grants poisoned".to_string())?
        .insert(normalized.clone());
    Ok(Some(normalized.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp() -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "notabene-grants-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(std::fs::canonicalize(dir).unwrap())
    }

    #[test]
    fn a_save_target_that_does_not_exist_yet_normalizes_through_its_parent() {
        let dir = temp();
        std::fs::create_dir_all(dir.0.join("sub")).unwrap();
        let target = dir.0.join("sub/../export.html");
        assert_eq!(normalize(&target), Some(dir.0.join("export.html")));
        // A path through folders that do not exist cannot be judged, so it
        // is refused rather than guessed at.
        assert_eq!(normalize(&dir.0.join("missing/export.html")), None);
        assert_eq!(normalize(&dir.0.join("missing/../export.html")), None);
    }

    #[test]
    fn only_a_chosen_backup_folder_is_listable_and_nothing_above_it() {
        let dir = temp();
        std::fs::create_dir_all(dir.0.join("backups")).unwrap();
        let grants = Grants::default();
        assert!(grants.listable(&dir.0.join("backups")).is_err());
        grants
            .backup_folders
            .lock()
            .unwrap()
            .insert(dir.0.join("backups"));
        assert!(grants.listable(&dir.0.join("backups")).is_ok());
        assert!(grants.listable(&dir.0).is_err());
        assert!(grants.under_backup_folder(&dir.0.join("backups/a.notabene-backup")));
        // `..` is resolved before comparing, so it cannot climb out.
        let escaped = normalize(&dir.0.join("backups/../elsewhere.txt")).unwrap();
        assert!(!grants.under_backup_folder(&escaped));
    }

    #[test]
    fn a_relocation_needs_a_folder_picked_this_session() {
        let dir = temp();
        let grants = Grants::default();
        assert!(grants.relocatable(&dir.0).is_err());
        grants.folders.lock().unwrap().insert(dir.0.clone());
        assert!(grants.relocatable(&dir.0).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_into_a_granted_folder_is_judged_by_where_it_points() {
        let dir = temp();
        let granted = dir.0.join("granted");
        let outside = dir.0.join("outside");
        std::fs::create_dir_all(&granted).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, granted.join("link")).unwrap();
        let grants = Grants::default();
        grants
            .backup_folders
            .lock()
            .unwrap()
            .insert(granted.clone());
        let through_link = normalize(&granted.join("link/x.notabene-backup")).unwrap();
        assert!(!grants.under_backup_folder(&through_link));
    }
}
