//! Lecture recordings, written as they are captured (plan §10.0 item 3).
//!
//! The microphone and the encoder live in the webview (`MediaRecorder`); this
//! module only owns the file. Every few seconds the webview hands over the
//! slice it has just encoded and it is appended here and flushed, so a crash or
//! a force-quit at minute 79 keeps 79 minutes. A recording in progress is two
//! files in `recordings/` under the app data directory: `{id}.part`, the audio
//! so far, and `{id}.json`, which note it belongs to. Finishing moves the audio
//! into the content-addressed asset store without the bytes crossing IPC again
//! — a lecture is tens of megabytes — and deletes both.
//!
//! Whatever is still in `recordings/` at launch was interrupted, and the
//! recovery prompt offers it back. `Active` is what stops a recording that is
//! merely *running* from being offered as interrupted.
//!
//! The directory is app data rather than the library folder on purpose: it
//! holds nothing a backup or a library move should carry, and it must stay
//! writable while a second Mac holds the library lock.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::commands::asset_file_path;
use crate::db::location::LibraryAccess;
use crate::db::model::Asset;
use crate::db::{assets, DbError, DbResult, Store};

const RECORDINGS_DIR: &str = "recordings";

/// A four-second slice at 64 kb/s is about 32 kB. Anything near this is not
/// a slice of speech, and refusing it keeps one bad call from filling a disk.
const MAX_SLICE_BYTES: usize = 8 * 1024 * 1024;

/// About thirty hours at 64 kb/s — a ceiling no lecture reaches, so a runaway
/// recorder stops before the disk does.
const MAX_RECORDING_BYTES: u64 = 1024 * 1024 * 1024;

/// Recordings this process is writing now. Never offered as interrupted.
#[derive(Default)]
pub struct ActiveRecordings(Mutex<HashSet<String>>);

impl ActiveRecordings {
    fn contains(&self, id: &str) -> bool {
        self.0.lock().map(|set| set.contains(id)).unwrap_or(false)
    }
    fn insert(&self, id: &str) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(id.to_owned());
        }
    }
    fn remove(&self, id: &str) {
        if let Ok(mut set) = self.0.lock() {
            set.remove(id);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingMeta {
    id: String,
    note_id: String,
    mime: String,
    started_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedRecording {
    id: String,
    note_id: String,
    mime: String,
    started_at: String,
    bytes: u64,
}

fn io(error: std::io::Error) -> DbError {
    DbError::Other(error.to_string())
}

/// Ids arrive from the webview and become file names, so they are held to the
/// alphabet `newId()` produces before they get anywhere near a path.
fn check_id(id: &str) -> DbResult<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(DbError::Other("invalid recording id".into()))
    }
}

/// `audio/mp4;codecs=mp4a.40.2` → `audio/mp4`. Only audio is accepted: this
/// is the one door into the asset store that does not go through `assets_put`.
fn clean_mime(mime: &str) -> DbResult<String> {
    let base = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let valid = base.starts_with("audio/")
        && base.len() <= 64
        && base.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '-' | '.' | '+')
        });
    if valid {
        Ok(base)
    } else {
        Err(DbError::Other("recordings must be audio".into()))
    }
}

fn directory(app: &AppHandle) -> DbResult<PathBuf> {
    Ok(crate::db::data_dir(app)?.join(RECORDINGS_DIR))
}

fn part_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.part"))
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn read_meta(dir: &Path, id: &str) -> DbResult<RecordingMeta> {
    let text = fs::read_to_string(meta_path(dir, id)).map_err(io)?;
    serde_json::from_str(&text).map_err(|error| DbError::Other(error.to_string()))
}

fn begin_in(dir: &Path, meta: &RecordingMeta) -> DbResult<()> {
    fs::create_dir_all(dir).map_err(io)?;
    let part = part_path(dir, &meta.id);
    // `create_new`: an id is minted once, and reopening an existing file would
    // write a second recording's header into the middle of the first.
    File::options()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(io)?;
    let json = serde_json::to_vec(meta).map_err(|error| DbError::Other(error.to_string()))?;
    fs::write(meta_path(dir, &meta.id), json).map_err(io)?;
    Ok(())
}

fn append_in(dir: &Path, id: &str, bytes: &[u8]) -> DbResult<u64> {
    let part = part_path(dir, id);
    let current = fs::metadata(&part).map_err(io)?.len();
    if current + bytes.len() as u64 > MAX_RECORDING_BYTES {
        return Err(DbError::Other("recording is too large".into()));
    }
    let mut file = OpenOptions::new().append(true).open(&part).map_err(io)?;
    file.write_all(bytes).map_err(io)?;
    // Each slice is flushed to the disk before the webview hears it landed.
    // That is the whole promise: what was acknowledged survives a power cut.
    file.sync_data().map_err(io)?;
    Ok(current + bytes.len() as u64)
}

fn interrupted_in(dir: &Path, active: &ActiveRecordings) -> Vec<InterruptedRecording> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if check_id(id).is_err() || active.contains(id) {
            continue;
        }
        let Ok(meta) = read_meta(dir, id) else {
            continue;
        };
        let bytes = fs::metadata(part_path(dir, id))
            .map(|m| m.len())
            .unwrap_or(0);
        found.push(InterruptedRecording {
            id: meta.id,
            note_id: meta.note_id,
            mime: meta.mime,
            started_at: meta.started_at,
            bytes,
        });
    }
    found.sort_by(|left, right| left.started_at.cmp(&right.started_at));
    found
}

fn discard_in(dir: &Path, id: &str) -> DbResult<()> {
    for path in [part_path(dir, id), meta_path(dir, id)] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io(error)),
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> DbResult<(String, u64)> {
    let mut file = File::open(path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    let id = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((id, total))
}

/// Move a recording into the asset store. The part file is copied rather than
/// renamed: the library may sit on another volume, and a rename that fails
/// halfway must not be the step that loses the lecture. The originals are
/// removed only after the asset row is written.
fn finish_in(dir: &Path, id: &str, store: &Store, access: &LibraryAccess) -> DbResult<Asset> {
    store.ensure_writable()?;
    let meta = read_meta(dir, id)?;
    let part = part_path(dir, id);
    let (asset_id, bytes) = sha256_file(&part)?;
    if bytes == 0 {
        return Err(DbError::Other("the recording is empty".into()));
    }
    let target = asset_file_path(access, &asset_id)?;
    if !target.exists() {
        let parent = target
            .parent()
            .ok_or_else(|| DbError::Other("asset path has no parent".into()))?;
        fs::create_dir_all(parent).map_err(io)?;
        let temporary = parent.join(format!(".{asset_id}.tmp"));
        fs::copy(&part, &temporary).map_err(io)?;
        File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(io)?;
        fs::rename(&temporary, &target).map_err(io)?;
    }
    let asset = Asset {
        id: asset_id,
        mime: meta.mime,
        bytes: i64::try_from(bytes).map_err(|_| DbError::Other("asset is too large".into()))?,
        width: None,
        height: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    assets::upsert_asset(store, &asset)?;
    discard_in(dir, id)?;
    Ok(asset)
}

#[tauri::command]
pub fn recording_begin(
    app: AppHandle,
    active: State<'_, ActiveRecordings>,
    id: String,
    note_id: String,
    mime: String,
) -> DbResult<()> {
    check_id(&id)?;
    check_id(&note_id)?;
    let meta = RecordingMeta {
        id: id.clone(),
        note_id,
        mime: clean_mime(&mime)?,
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    begin_in(&directory(&app)?, &meta)?;
    active.insert(&id);
    Ok(())
}

/// Returns the recording's size so far, which the webview does not otherwise
/// know without keeping every slice in memory.
#[tauri::command]
pub async fn recording_append(
    app: AppHandle,
    active: State<'_, ActiveRecordings>,
    id: String,
    data: String,
) -> DbResult<u64> {
    check_id(&id)?;
    if !active.contains(&id) {
        return Err(DbError::Other("that recording is not running".into()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| DbError::Other(format!("invalid recording data: {error}")))?;
    if bytes.len() > MAX_SLICE_BYTES {
        return Err(DbError::Other("recording slice is too large".into()));
    }
    let dir = directory(&app)?;
    // `sync_data` can take a moment on a busy disk; off the main thread so it
    // never shows up as a stutter in the editor.
    tauri::async_runtime::spawn_blocking(move || append_in(&dir, &id, &bytes))
        .await
        .map_err(|error| DbError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn recording_finish(
    app: AppHandle,
    active: State<'_, ActiveRecordings>,
    id: String,
) -> DbResult<Asset> {
    check_id(&id)?;
    let dir = directory(&app)?;
    let handle = app.clone();
    let task_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let store = tauri::Manager::state::<Store>(&handle);
        let access = tauri::Manager::state::<LibraryAccess>(&handle);
        finish_in(&dir, &task_id, &store, &access)
    })
    .await
    .map_err(|error| DbError::Other(error.to_string()))?;
    // Only a finished recording stops being active. A failed finish leaves the
    // files and — after a relaunch — the recovery offer.
    if result.is_ok() {
        active.remove(&id);
    }
    result
}

/// Throw a recording away: the student cancelled it, or declined to keep an
/// interrupted one. The only permanent deletion here, and only of audio that
/// never became library content.
#[tauri::command]
pub fn recording_discard(
    app: AppHandle,
    active: State<'_, ActiveRecordings>,
    id: String,
) -> DbResult<()> {
    check_id(&id)?;
    discard_in(&directory(&app)?, &id)?;
    active.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn recording_interrupted(
    app: AppHandle,
    active: State<'_, ActiveRecordings>,
) -> DbResult<Vec<InterruptedRecording>> {
    Ok(interrupted_in(&directory(&app)?, &active))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(label: &str) -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "notabene-recording-{label}-{}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    fn meta(id: &str) -> RecordingMeta {
        RecordingMeta {
            id: id.into(),
            note_id: "note1".into(),
            mime: "audio/mp4".into(),
            started_at: "2026-09-28T09:00:00Z".into(),
        }
    }

    #[test]
    fn ids_that_could_leave_the_directory_are_refused() {
        assert!(check_id("abc-DEF_123").is_ok());
        for bad in ["", "../x", "a/b", "a.b", &"x".repeat(65)] {
            assert!(check_id(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn only_audio_mimes_are_accepted_and_parameters_are_dropped() {
        assert_eq!(
            clean_mime("audio/mp4;codecs=mp4a.40.2").unwrap(),
            "audio/mp4"
        );
        assert_eq!(clean_mime("audio/webm; codecs=opus").unwrap(), "audio/webm");
        assert!(clean_mime("text/html").is_err());
        assert!(clean_mime("audio/<script>").is_err());
    }

    #[test]
    fn slices_accumulate_and_an_unfinished_recording_is_offered_back() {
        let dir = temp_dir("append");
        begin_in(&dir.0, &meta("rec1")).unwrap();
        assert_eq!(append_in(&dir.0, "rec1", b"abc").unwrap(), 3);
        assert_eq!(append_in(&dir.0, "rec1", b"defg").unwrap(), 7);
        assert_eq!(fs::read(part_path(&dir.0, "rec1")).unwrap(), b"abcdefg");

        let active = ActiveRecordings::default();
        active.insert("rec1");
        assert!(
            interrupted_in(&dir.0, &active).is_empty(),
            "a running recording is not interrupted"
        );

        let relaunched = ActiveRecordings::default();
        let found = interrupted_in(&dir.0, &relaunched);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "rec1");
        assert_eq!(found[0].note_id, "note1");
        assert_eq!(found[0].bytes, 7);
    }

    #[test]
    fn an_id_is_never_reopened() {
        let dir = temp_dir("reopen");
        begin_in(&dir.0, &meta("rec1")).unwrap();
        append_in(&dir.0, "rec1", b"first").unwrap();
        assert!(begin_in(&dir.0, &meta("rec1")).is_err());
        assert_eq!(fs::read(part_path(&dir.0, "rec1")).unwrap(), b"first");
    }

    #[test]
    fn discarding_removes_both_files() {
        let dir = temp_dir("discard");
        begin_in(&dir.0, &meta("rec1")).unwrap();
        discard_in(&dir.0, "rec1").unwrap();
        assert!(!part_path(&dir.0, "rec1").exists());
        assert!(!meta_path(&dir.0, "rec1").exists());
        // Twice is fine: the second answer to a prompt must not fail.
        discard_in(&dir.0, "rec1").unwrap();
    }

    #[test]
    fn the_hash_is_the_content_address() {
        let dir = temp_dir("hash");
        let path = dir.0.join("f");
        fs::write(&path, b"abc").unwrap();
        let (id, bytes) = sha256_file(&path).unwrap();
        assert_eq!(bytes, 3);
        assert_eq!(
            id,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
