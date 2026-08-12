//! The movable library directory and its best-effort cross-machine lock.
//!
//! Dropbox and iCloud synchronize files, not SQLite locks. A small ownership
//! file therefore travels with the library. Its heartbeat makes a crashed
//! owner reclaimable; a token prevents a resumed Mac from overwriting the new
//! owner's lock. Losing ownership only ever downgrades this process to
//! read-only — becoming writable again requires a clean relaunch.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, RecvTimeoutError},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;

use chrono::{DateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{DbError, DbResult, Store};

pub const DATABASE_FILE: &str = "notabene.sqlite3";
pub const ASSETS_DIR: &str = "assets";
pub const LOCK_FILE: &str = ".notabene-library.lock";
const MACHINE_ID_FILE: &str = "machine-id";
const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const STALE_AFTER_SECONDS: i64 = 5 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockOwner {
    pub machine_id: String,
    pub host: String,
    pub process_id: u32,
    pub token: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAccessStatus {
    pub library_dir: String,
    pub read_only: bool,
    pub lock_owner: Option<LockOwnerStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockOwnerStatus {
    pub host: String,
    pub process_id: u32,
    pub updated_at: String,
}

pub struct LibraryAccess {
    directory: PathBuf,
    read_only: Arc<AtomicBool>,
    owner: Arc<Mutex<Option<LockOwner>>>,
    token: Option<String>,
    stop: Option<mpsc::Sender<()>>,
    monitor: Option<JoinHandle<()>>,
}

impl LibraryAccess {
    pub fn initialize(app: &AppHandle) -> DbResult<Self> {
        let directory = match crate::settings::configured_library_location(app) {
            Ok(Some(path)) => path,
            Ok(None) => super::data_dir(app)?,
            Err(error) => return Err(DbError::Other(error)),
        };
        fs::create_dir_all(&directory).map_err(io_error)?;
        let directory = fs::canonicalize(&directory).map_err(io_error)?;
        let machine_id = machine_id(app)?;
        let lock_path = directory.join(LOCK_FILE);

        match acquire(&lock_path, &machine_id)? {
            LockAttempt::Owned(metadata) => Ok(Self {
                directory,
                read_only: Arc::new(AtomicBool::new(false)),
                owner: Arc::new(Mutex::new(None)),
                token: Some(metadata.token),
                stop: None,
                monitor: None,
            }),
            LockAttempt::Held(owner) => Ok(Self {
                directory,
                read_only: Arc::new(AtomicBool::new(true)),
                owner: Arc::new(Mutex::new(owner)),
                token: None,
                stop: None,
                monitor: None,
            }),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn database_path(&self) -> PathBuf {
        self.directory.join(DATABASE_FILE)
    }

    pub fn assets_path(&self) -> PathBuf {
        self.directory.join(ASSETS_DIR)
    }

    pub fn read_only_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.read_only)
    }

    pub fn status(&self) -> LibraryAccessStatus {
        LibraryAccessStatus {
            library_dir: self.directory.to_string_lossy().into_owned(),
            read_only: self.read_only.load(Ordering::Acquire),
            lock_owner: self
                .owner
                .lock()
                .expect("lock owner mutex poisoned")
                .as_ref()
                .map(|owner| LockOwnerStatus {
                    host: owner.host.clone(),
                    process_id: owner.process_id,
                    updated_at: owner.updated_at.clone(),
                }),
        }
    }

    pub fn start_monitor(&mut self, store: Store) {
        let Some(token) = self.token.clone() else {
            return;
        };
        let path = self.directory.join(LOCK_FILE);
        let owner = Arc::clone(&self.owner);
        let read_only = Arc::clone(&self.read_only);
        let (stop, receiver) = mpsc::channel();
        self.stop = Some(stop);
        self.monitor = Some(std::thread::spawn(move || loop {
            match receiver.recv_timeout(HEARTBEAT_EVERY) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }

            match refresh(&path, &token) {
                Ok(Refresh::Owned) => {}
                Ok(Refresh::Lost(blocker)) => {
                    read_only.store(true, Ordering::Release);
                    *owner.lock().expect("lock owner mutex poisoned") = blocker;
                    if let Err(error) = store.make_read_only() {
                        eprintln!("failed to enforce read-only library: {error}");
                    }
                    break;
                }
                Err(error) => {
                    // A transient synced-folder error must not make the app
                    // write without a lock it can prove it still owns.
                    eprintln!("library lock heartbeat failed: {error}");
                    read_only.store(true, Ordering::Release);
                    if let Err(error) = store.make_read_only() {
                        eprintln!("failed to enforce read-only library: {error}");
                    }
                    break;
                }
            }
        }));
    }
}

impl Drop for LibraryAccess {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(monitor) = self.monitor.take() {
            let _ = monitor.join();
        }
        let Some(token) = &self.token else {
            return;
        };
        let path = self.directory.join(LOCK_FILE);
        if read_owner(&path)
            .ok()
            .flatten()
            .as_ref()
            .map(|owner| &owner.token)
            == Some(token)
        {
            let _ = fs::remove_file(path);
        }
    }
}

enum LockAttempt {
    Owned(LockOwner),
    Held(Option<LockOwner>),
}

enum Refresh {
    Owned,
    Lost(Option<LockOwner>),
}

fn acquire(path: &Path, machine_id: &str) -> DbResult<LockAttempt> {
    for _ in 0..3 {
        let metadata = new_owner(machine_id);
        match write_new(path, &metadata) {
            Ok(()) => return Ok(LockAttempt::Owned(metadata)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = read_owner(path)?;
                if stale(existing.as_ref(), machine_id, path) {
                    match fs::remove_file(path) {
                        Ok(()) => continue,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(io_error(error)),
                    }
                }
                return Ok(LockAttempt::Held(existing));
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(LockAttempt::Held(read_owner(path)?))
}

fn refresh(path: &Path, token: &str) -> DbResult<Refresh> {
    let Some(mut owner) = read_owner(path)? else {
        return Ok(Refresh::Lost(None));
    };
    if owner.token != token {
        return Ok(Refresh::Lost(Some(owner)));
    }
    owner.updated_at = Utc::now().to_rfc3339();
    let temporary = path.with_extension(format!("lock-{token}.tmp"));
    write_existing(&temporary, &owner)?;
    // Re-check immediately before the replace. A resumed stale owner must not
    // overwrite the token that took over while it was asleep.
    if read_owner(path)?
        .as_ref()
        .map(|current| current.token.as_str())
        != Some(token)
    {
        let _ = fs::remove_file(temporary);
        return Ok(Refresh::Lost(read_owner(path)?));
    }
    fs::rename(temporary, path).map_err(io_error)?;
    Ok(Refresh::Owned)
}

fn stale(owner: Option<&LockOwner>, machine_id: &str, path: &Path) -> bool {
    if owner.is_some_and(|owner| owner.machine_id == machine_id) {
        // The single-instance plugin runs before setup, so another live
        // NotaBene process on this machine cannot reach this point.
        return true;
    }
    let updated = owner
        .and_then(|owner| DateTime::parse_from_rfc3339(&owner.updated_at).ok())
        .map(|time| time.with_timezone(&Utc))
        .or_else(|| {
            fs::metadata(path)
                .ok()?
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
        });
    updated.is_some_and(|time| (Utc::now() - time).num_seconds() > STALE_AFTER_SECONDS)
}

fn new_owner(machine_id: &str) -> LockOwner {
    LockOwner {
        machine_id: machine_id.to_string(),
        host: std::env::var("HOSTNAME").unwrap_or_else(|_| "another Mac".into()),
        process_id: std::process::id(),
        token: random_id(),
        updated_at: Utc::now().to_rfc3339(),
    }
}

fn machine_id(app: &AppHandle) -> DbResult<String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| DbError::Other(error.to_string()))?
        .join(MACHINE_ID_FILE);
    if let Ok(id) = fs::read_to_string(&path) {
        let id = id.trim();
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let id = random_id();
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(id.as_bytes()).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            Ok(id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => fs::read_to_string(path)
            .map(|value| value.trim().to_string())
            .map_err(io_error),
        Err(error) => Err(io_error(error)),
    }
}

fn read_owner(path: &Path) -> DbResult<Option<LockOwner>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(io_error)?;
    Ok(serde_json::from_str(&text).ok())
}

fn write_new(path: &Path, owner: &LockOwner) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, owner).map_err(std::io::Error::other)?;
    file.write_all(b"\n")?;
    file.sync_all()
}

fn write_existing(path: &Path, owner: &LockOwner) -> DbResult<()> {
    let mut file = File::create(path).map_err(io_error)?;
    serde_json::to_writer_pretty(&mut file, owner)
        .map_err(|error| DbError::Other(error.to_string()))?;
    file.write_all(b"\n").map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

fn random_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    (0..20)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

fn io_error(error: std::io::Error) -> DbError {
    DbError::Other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::Note;
    use crate::db::notes;

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(label: &str) -> TempDir {
        let path = std::env::temp_dir().join(format!("notabene-lock-{label}-{}", random_id()));
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    #[test]
    fn a_live_foreign_owner_forces_read_only() {
        let dir = temp_dir("foreign");
        let path = dir.0.join(LOCK_FILE);
        let owner = new_owner("other-machine");
        write_new(&path, &owner).unwrap();

        match acquire(&path, "this-machine").unwrap() {
            LockAttempt::Held(Some(found)) => assert_eq!(found.token, owner.token),
            _ => panic!("the foreign lock should be kept"),
        }
    }

    #[test]
    fn a_same_machine_crash_lock_is_reclaimed() {
        let dir = temp_dir("stale");
        let path = dir.0.join(LOCK_FILE);
        write_new(&path, &new_owner("this-machine")).unwrap();

        match acquire(&path, "this-machine").unwrap() {
            LockAttempt::Owned(owner) => {
                assert_eq!(read_owner(&path).unwrap().unwrap().token, owner.token)
            }
            _ => panic!("the stale lock should be replaced"),
        }
    }

    #[test]
    fn a_replaced_token_cannot_be_heartbeated_over() {
        let dir = temp_dir("token");
        let path = dir.0.join(LOCK_FILE);
        let old = new_owner("old-machine");
        write_new(&path, &old).unwrap();
        fs::remove_file(&path).unwrap();
        let replacement = new_owner("new-machine");
        write_new(&path, &replacement).unwrap();

        assert!(matches!(
            refresh(&path, &old.token).unwrap(),
            Refresh::Lost(_)
        ));
        assert_eq!(read_owner(&path).unwrap().unwrap().token, replacement.token);
    }

    #[test]
    fn a_read_only_store_refuses_writes_at_the_database_boundary() {
        let dir = temp_dir("read-only");
        let database = dir.0.join(DATABASE_FILE);
        let writable = Store::open(&database, Arc::new(AtomicBool::new(false))).unwrap();
        drop(writable);
        let read_only = Store::open(&database, Arc::new(AtomicBool::new(true))).unwrap();
        let note = Note {
            id: "blocked".into(),
            course_id: None,
            section_id: None,
            title: "Blocked".into(),
            doc: serde_json::json!({ "type": "doc", "content": [] }),
            plain_text: String::new(),
            tag_ids: Vec::new(),
            pinned: false,
            archived: false,
            trashed_at: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            order: 0,
        };

        let error = notes::upsert(&read_only, &note).expect_err("write must be refused");

        assert!(matches!(error, DbError::ReadOnly));
    }
}
