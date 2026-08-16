//! What is on disk, and whether it is intact.
//!
//! Everything NotaBene keeps lives in one directory. This module is the only
//! thing that measures it, lists the backups inside it, and answers "is the
//! database still sound?" — so Settings can show a student exactly what the
//! privacy promise amounts to in bytes.
//!
//! The directory walk runs on a blocking thread. A synchronous Tauri command
//! runs on the main thread, and recursing through a few thousand attachments
//! there would freeze the window.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::location::{LibraryAccess, LibraryAccessStatus};
use crate::db::{self, transfer, DbError, DbResult, Store};

/// Filename suffix shared by every archive NotaBene writes.
pub const BACKUP_EXTENSION: &str = ".notabene-backup";

/// Archives written immediately before a destructive restore. They are the way
/// back from a restore the user did not mean, so they are pruned on their own,
/// much shallower schedule rather than competing with scheduled backups.
pub const SAFETY_PREFIX: &str = "NotaBene-before-restore-";
const SAFETY_KEEP: usize = 3;

/// `PRAGMA quick_check` from launch, recorded so Settings can warn without the
/// user having to go looking. Empty is the healthy case.
pub struct StartupIntegrity(pub Vec<String>);

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCounts {
    pub courses: i64,
    pub notes: i64,
    pub trashed_notes: i64,
    pub attachments: i64,
    pub snapshots: i64,
    pub tags: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSizes {
    /// `notabene.sqlite3` itself.
    pub database_bytes: u64,
    /// The write-ahead log and shared-memory file beside it. Reported apart
    /// from the database because a large WAL is normal and temporary, and
    /// folding it in makes the database look like it doubled overnight.
    pub wal_bytes: u64,
    pub assets_bytes: u64,
    pub backups_bytes: u64,
    /// Local AI models the user chose to download — the speech ones today.
    /// Broken out because they are gigabytes beside a library of megabytes, and
    /// folded into "other" they made settings.json look like it had eaten the
    /// disk.
    pub models_bytes: u64,
    /// `settings.json` and the secret index. Bytes only — never contents.
    pub settings_bytes: u64,
    pub other_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub library_dir: String,
    pub app_data_dir: String,
    pub backups_dir: String,
    #[serde(flatten)]
    pub sizes: StorageSizes,
    pub counts: StorageCounts,
    pub startup_problems: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub modified_at: String,
    /// True for the archives written just before a restore.
    pub safety: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub ok: bool,
    pub problems: Vec<String>,
}

fn counts(store: &Store) -> DbResult<StorageCounts> {
    store.with(|connection| {
        let one = |sql: &str| -> DbResult<i64> {
            Ok(connection.query_row(sql, [], |row| row.get::<_, i64>(0))?)
        };
        Ok(StorageCounts {
            courses: one("SELECT count(*) FROM courses")?,
            notes: one("SELECT count(*) FROM notes WHERE trashed_at IS NULL")?,
            trashed_notes: one("SELECT count(*) FROM notes WHERE trashed_at IS NOT NULL")?,
            attachments: one("SELECT count(*) FROM attachments")?,
            snapshots: one("SELECT count(*) FROM snapshots")?,
            tags: one("SELECT count(*) FROM tags")?,
        })
    })
}

fn directory_bytes(path: &Path, excluded: Option<&Path>) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| excluded.is_none_or(|excluded| entry.path() != excluded))
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => directory_bytes(&entry.path(), excluded),
            // Symlinks are counted as the link, not the target: following them
            // would double-count anything inside the data directory and could
            // walk out of it entirely.
            Ok(_) => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn measure(data_dir: &Path, excluded: Option<&Path>) -> StorageSizes {
    let mut sizes = StorageSizes::default();
    let Ok(entries) = fs::read_dir(data_dir) else {
        return sizes;
    };
    for entry in entries.flatten() {
        if excluded.is_some_and(|excluded| entry.path() == excluded) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let bytes = if is_dir {
            directory_bytes(&entry.path(), excluded)
        } else {
            entry.metadata().map(|meta| meta.len()).unwrap_or(0)
        };
        match name.as_str() {
            "notabene.sqlite3" => sizes.database_bytes += bytes,
            "notabene.sqlite3-wal" | "notabene.sqlite3-shm" => sizes.wal_bytes += bytes,
            "assets" => sizes.assets_bytes += bytes,
            "backups" => sizes.backups_bytes += bytes,
            // Where `KokoroManager` and the Voxtral manager install their
            // artifacts: `models/<name>/<revision>/`.
            "models" => sizes.models_bytes += bytes,
            "settings.json" | "secrets.json" | "secret-keys.json" => sizes.settings_bytes += bytes,
            _ => sizes.other_bytes += bytes,
        }
        sizes.total_bytes += bytes;
    }
    sizes
}

fn add_sizes(left: &mut StorageSizes, right: StorageSizes) {
    left.database_bytes += right.database_bytes;
    left.wal_bytes += right.wal_bytes;
    left.assets_bytes += right.assets_bytes;
    left.backups_bytes += right.backups_bytes;
    left.models_bytes += right.models_bytes;
    left.settings_bytes += right.settings_bytes;
    left.other_bytes += right.other_bytes;
    left.total_bytes += right.total_bytes;
}

#[tauri::command]
pub fn library_access_status(access: State<'_, LibraryAccess>) -> LibraryAccessStatus {
    access.status()
}

#[tauri::command]
pub async fn library_relocate(app: AppHandle, destination: String) -> DbResult<String> {
    let destination = PathBuf::from(destination);
    tauri::async_runtime::spawn_blocking(move || {
        let access = app.state::<LibraryAccess>();
        let source = access.directory().to_path_buf();
        let relocated = transfer::relocate_library(&app.state::<Store>(), &source, &destination)?;
        Ok(relocated.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| DbError::Other(error.to_string()))?
}

fn read_backups(dir: &Path) -> Vec<BackupFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<BackupFile> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(BACKUP_EXTENSION) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified = meta
                .modified()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
                .unwrap_or_default();
            Some(BackupFile {
                safety: name.starts_with(SAFETY_PREFIX),
                name,
                path: entry.path().to_string_lossy().into_owned(),
                bytes: meta.len(),
                modified_at: modified,
            })
        })
        .collect();
    // Newest first: the list is read top-down and the most recent backup is the
    // one anybody is looking for. The name breaks ties, and does it correctly —
    // `NotaBene-2026-01-02-0900` sorts after `NotaBene-2026-01-01-0900` because
    // the timestamp in the filename is written big-endian for exactly this.
    files.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| b.name.cmp(&a.name))
    });
    files
}

/// The folder NotaBene manages, created on demand.
#[tauri::command]
pub fn backups_dir(app: AppHandle) -> DbResult<String> {
    let dir = db::backups_path(&app)?;
    fs::create_dir_all(&dir).map_err(|error| DbError::Other(error.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Fixed destination for non-interactive exports requested over MCP.
#[tauri::command]
pub fn exports_dir(app: AppHandle) -> DbResult<String> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|error| DbError::Other(error.to_string()))?
        .join("NotaBene exports");
    fs::create_dir_all(&dir).map_err(|error| DbError::Other(error.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// List archives. `folder` is the user's chosen folder when they have one;
/// omitting it reads the folder NotaBene manages.
#[tauri::command]
pub async fn backups_list(app: AppHandle, folder: Option<String>) -> DbResult<Vec<BackupFile>> {
    let dir: PathBuf = match folder {
        Some(folder) => PathBuf::from(folder),
        None => db::backups_path(&app)?,
    };
    tauri::async_runtime::spawn_blocking(move || read_backups(&dir))
        .await
        .map_err(|error| DbError::Other(error.to_string()))
}

/// Read an archive back off disk.
///
/// This exists rather than the webview's `readFile` because the webview's file
/// scope only covers a handful of static roots plus whatever the user picked
/// *this session*. A backup folder chosen last month, on an external drive,
/// falls outside both — and reading it back is precisely how a written archive
/// earns the name "backup". Reading through Rust, which wrote the file, keeps
/// verification working wherever the file went.
///
/// The extension lock is what stops this from being a general file-read over
/// IPC: the only thing it can ever return is an archive NotaBene wrote.
#[tauri::command]
pub async fn backups_read(path: String) -> DbResult<String> {
    if !path.ends_with(BACKUP_EXTENSION) {
        return Err(DbError::Other(format!(
            "{path} is not a NotaBene backup archive"
        )));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|error| DbError::Other(error.to_string()))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|error| DbError::Other(error.to_string()))?
}

/// Delete all but the newest `keep` archives **in the folder NotaBene manages**.
///
/// It takes no folder argument, and that is the point rather than an oversight:
/// files in a folder the user picked are theirs, sit beside their own documents,
/// and are never NotaBene's to delete. Making the managed folder unaddressable
/// from outside is what guarantees a bug here cannot reach them.
#[tauri::command]
pub async fn backups_prune(app: AppHandle, keep: usize) -> DbResult<usize> {
    let dir = db::backups_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (safety, scheduled): (Vec<BackupFile>, Vec<BackupFile>) =
            read_backups(&dir).into_iter().partition(|file| file.safety);
        // Never prune to nothing, however low the setting: one archive is the
        // difference between a bad day and a lost semester.
        let keep_scheduled = keep.max(1);
        let stale = scheduled
            .into_iter()
            .skip(keep_scheduled)
            .chain(safety.into_iter().skip(SAFETY_KEEP));
        let mut removed = 0;
        for file in stale {
            if fs::remove_file(&file.path).is_ok() {
                removed += 1;
            }
        }
        removed
    })
    .await
    .map_err(|error| DbError::Other(error.to_string()))
}

/// The full `PRAGMA integrity_check`, off the main thread — it walks every page
/// and on a large library that is long enough to freeze the window.
#[tauri::command]
pub async fn db_integrity_check(app: AppHandle) -> DbResult<IntegrityReport> {
    let problems = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Store>().integrity_problems(false)
    })
    .await
    .map_err(|error| DbError::Other(error.to_string()))??;
    Ok(IntegrityReport {
        ok: problems.is_empty(),
        problems,
    })
}

#[tauri::command]
pub async fn storage_summary(
    app: AppHandle,
    integrity: State<'_, StartupIntegrity>,
    access: State<'_, LibraryAccess>,
) -> DbResult<StorageSummary> {
    let startup_problems = integrity.0.clone();
    let app_data_dir = db::data_dir(&app)?;
    let library_dir = access.directory().to_path_buf();
    let backups_dir = db::backups_path(&app)?;

    let handle = app.clone();
    let walk_app = app_data_dir.clone();
    let walk_library = library_dir.clone();
    let (sizes, counts) = tauri::async_runtime::spawn_blocking(move || {
        // Counts are `SELECT count(*)` over indexed tables — microseconds, and
        // deliberately not `library_export`, which would pull every note body
        // and every snapshot into memory to answer "how many notes?".
        let mut sizes = if walk_app == walk_library {
            measure(&walk_library, None)
        } else {
            let excluded = walk_library
                .parent()
                .is_some_and(|_| walk_library.starts_with(&walk_app))
                .then_some(walk_library.as_path());
            let mut sizes = measure(&walk_app, excluded);
            add_sizes(&mut sizes, measure(&walk_library, None));
            sizes
        };
        // The lock file is coordination metadata, not library content. It is
        // intentionally excluded from the user-facing size total just as it
        // is excluded from every backup archive.
        let lock_bytes = fs::metadata(walk_library.join(crate::db::location::LOCK_FILE))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        sizes.other_bytes = sizes.other_bytes.saturating_sub(lock_bytes);
        sizes.total_bytes = sizes.total_bytes.saturating_sub(lock_bytes);
        (sizes, counts(&handle.state::<Store>()))
    })
    .await
    .map_err(|error| DbError::Other(error.to_string()))?;

    Ok(StorageSummary {
        library_dir: library_dir.to_string_lossy().into_owned(),
        app_data_dir: app_data_dir.to_string_lossy().into_owned(),
        backups_dir: backups_dir.to_string_lossy().into_owned(),
        sizes,
        counts: counts?,
        startup_problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same shape as the temp store in `db::notes` — the repo rolls its own
    /// rather than carrying a dev-dependency for four lines.
    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(label: &str) -> TempDir {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("notabene-{label}-{unique}"));
        fs::create_dir_all(&path).expect("failed to create temp dir");
        TempDir(path)
    }

    #[test]
    fn sizes_are_bucketed_by_what_the_file_is() {
        let dir = temp_dir("sizes");
        let root = dir.0.as_path();
        fs::write(root.join("notabene.sqlite3"), vec![0u8; 100]).unwrap();
        fs::write(root.join("notabene.sqlite3-wal"), vec![0u8; 10]).unwrap();
        fs::write(root.join("settings.json"), vec![0u8; 5]).unwrap();
        fs::write(root.join("stray.log"), vec![0u8; 3]).unwrap();
        fs::create_dir_all(root.join("assets/ab")).unwrap();
        fs::write(root.join("assets/ab/abcdef"), vec![0u8; 50]).unwrap();
        fs::create_dir_all(root.join("backups")).unwrap();
        fs::write(root.join("backups/a.notabene-backup"), vec![0u8; 7]).unwrap();
        fs::create_dir_all(root.join("models/kokoro-82m/v1")).unwrap();
        fs::write(root.join("models/kokoro-82m/v1/model.onnx"), vec![0u8; 40]).unwrap();

        let sizes = measure(root, None);

        assert_eq!(sizes.database_bytes, 100);
        assert_eq!(sizes.wal_bytes, 10);
        assert_eq!(sizes.assets_bytes, 50, "nested asset shards must be walked");
        assert_eq!(sizes.backups_bytes, 7);
        assert_eq!(
            sizes.models_bytes, 40,
            "a downloaded model is its own category, not 'other'"
        );
        assert_eq!(sizes.settings_bytes, 5);
        assert_eq!(sizes.other_bytes, 3);
        assert_eq!(sizes.total_bytes, 215);
    }

    /// Write an archive with a known modification time. Ordering is by mtime,
    /// so a test that let the filesystem pick would pass or fail on whether the
    /// four writes happened to land in the same clock tick.
    fn write_backup(root: &Path, name: &str, minute: u64) {
        let path = root.join(name);
        fs::write(&path, vec![0u8; 1]).unwrap();
        let when =
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + minute * 60);
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(when))
            .unwrap();
    }

    #[test]
    fn listing_finds_archives_newest_first_and_flags_safety_copies() {
        let dir = temp_dir("listing");
        let root = dir.0.as_path();
        write_backup(root, "NotaBene-2026-01-01-0900.notabene-backup", 1);
        write_backup(root, "NotaBene-2026-01-03-0900.notabene-backup", 3);
        write_backup(root, "NotaBene-2026-01-02-0900.notabene-backup", 2);
        write_backup(
            root,
            "NotaBene-before-restore-2026-01-02-1000.notabene-backup",
            4,
        );
        // Neither of these is an archive, so neither may ever be listed — and
        // therefore neither can ever become a deletion candidate.
        fs::write(root.join("notes.txt"), vec![0u8; 1]).unwrap();
        fs::write(root.join("NotaBene-2026-01-04.notabene-tmp"), vec![0u8; 1]).unwrap();

        let listed = read_backups(root);

        assert_eq!(listed.len(), 4, "only .notabene-backup files are listed");
        let names: Vec<&str> = listed.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "NotaBene-before-restore-2026-01-02-1000.notabene-backup",
                "NotaBene-2026-01-03-0900.notabene-backup",
                "NotaBene-2026-01-02-0900.notabene-backup",
                "NotaBene-2026-01-01-0900.notabene-backup",
            ]
        );
        assert!(listed[0].safety, "the pre-restore copy is flagged");
        assert!(listed.iter().skip(1).all(|file| !file.safety));
    }
}
