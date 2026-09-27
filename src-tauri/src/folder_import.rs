//! Reading a folder of notes someone else's app wrote: a Markdown folder, an
//! Obsidian vault.
//!
//! This is the first command that reads outside the directories
//! `capabilities/default.json` scopes `fs` to -- a vault in `~/vaults` or in
//! iCloud Drive is exactly where people keep one. So the boundary is written
//! down, the way `web.rs` writes down its own:
//!
//! - **Only a folder the student picked.** `folder_import_pick` opens the
//!   native panel from Rust and remembers what came back. `folder_scan` and
//!   `folder_read` refuse any root that did not arrive that way, so a note
//!   whose content found a way to run script in the webview still cannot name
//!   `~/.ssh` and have it read. The webview never supplies a root of its own.
//! - **Never outside it.** Every path is relative, has no `..`, is not a
//!   symlink, and canonicalises to somewhere under the root.
//! - **Bounded.** The walk has a depth, a file count, and skips dotfiles --
//!   `.obsidian` and `.trash` included -- and never follows a symlink, because a
//!   loop inside a vault is a real hang. Reads have a per-file and a per-call
//!   byte ceiling, because every byte crosses IPC.
//!
//! The walk returns a manifest only, so the preview can say "900 notes, 40
//! images" before a single file has been read.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Deeper than any vault anyone navigates by hand.
const MAX_DEPTH: usize = 32;
/// Enough for a decade of daily notes and their images.
const MAX_FILES: usize = 20_000;
/// A single file larger than this is not a note or an illustration.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// One `folder_read` call's worth. The webview batches under it.
const MAX_READ_BYTES: u64 = 96 * 1024 * 1024;

/// Folders the student picked this session. A set rather than one slot so a
/// second import in the same session does not revoke the first mid-read.
#[derive(Default)]
pub struct ImportRoots(Mutex<HashSet<PathBuf>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// Relative to the root, `/`-separated whatever the platform.
    path: String,
    bytes: u64,
    modified_at: Option<String>,
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSkip {
    path: String,
    /// A code, not a sentence: `symlink`, `tooLarge`, `tooDeep`, `unreadable`.
    reason: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderManifest {
    root: String,
    files: Vec<FolderEntry>,
    skipped: Vec<FolderSkip>,
    /// The walk stopped at `MAX_FILES`. Said, never silent.
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFile {
    path: String,
    /// Set when the call asked for text: UTF-8, lossily, without a BOM.
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    /// Set when it asked for bytes: base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

fn timestamp(time: std::io::Result<std::time::SystemTime>) -> Option<String> {
    time.ok()
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn granted_root(roots: &ImportRoots, root: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("not_found:the folder could not be opened: {error}"))?;
    let granted = roots
        .0
        .lock()
        .map_err(|_| "io:import roots poisoned".to_owned())?;
    if granted.contains(&canonical) {
        Ok(canonical)
    } else {
        Err("not_picked:only a folder chosen in the import panel can be read".to_owned())
    }
}

/// A manifest path back to a file under `root`, or a refusal.
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(relative);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("outside_root:{relative}"));
    }
    let joined = root.join(candidate);
    let metadata =
        fs::symlink_metadata(&joined).map_err(|error| format!("not_found:{relative}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("outside_root:{relative}"));
    }
    // A symlinked *directory* above the file is the remaining way out, and
    // canonicalising is what catches it.
    let canonical =
        fs::canonicalize(&joined).map_err(|error| format!("not_found:{relative}: {error}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("outside_root:{relative}"));
    }
    Ok(canonical)
}

fn relative_string(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

fn scan(root: &Path) -> FolderManifest {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(root.to_path_buf(), 0usize)];

    'walk: while let Some((directory, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            if let Some(path) = relative_string(root, &directory) {
                skipped.push(FolderSkip {
                    path,
                    reason: "unreadable",
                });
            }
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        // Sorted, so the manifest -- and the preview -- come out the same way
        // every time the same folder is scanned.
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            // `.obsidian`, `.trash`, `.git`, `.DS_Store`: none of it is notes.
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Some(relative) = relative_string(root, &path) else {
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                skipped.push(FolderSkip {
                    path: relative,
                    reason: "unreadable",
                });
                continue;
            };
            if metadata.file_type().is_symlink() {
                skipped.push(FolderSkip {
                    path: relative,
                    reason: "symlink",
                });
                continue;
            }
            if metadata.is_dir() {
                if depth + 1 > MAX_DEPTH {
                    skipped.push(FolderSkip {
                        path: relative,
                        reason: "tooDeep",
                    });
                } else {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            if metadata.len() > MAX_FILE_BYTES {
                skipped.push(FolderSkip {
                    path: relative,
                    reason: "tooLarge",
                });
                continue;
            }
            if files.len() >= MAX_FILES {
                truncated = true;
                break 'walk;
            }
            files.push(FolderEntry {
                path: relative,
                bytes: metadata.len(),
                modified_at: timestamp(metadata.modified()),
                created_at: timestamp(metadata.created()),
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    FolderManifest {
        root: root.to_string_lossy().into_owned(),
        files,
        skipped,
        truncated,
    }
}

fn read(root: &Path, paths: &[String], as_text: bool) -> Result<Vec<FolderFile>, String> {
    let mut total = 0u64;
    let mut out = Vec::with_capacity(paths.len());
    for relative in paths {
        let path = resolve(root, relative)?;
        let bytes = fs::read(&path).map_err(|error| format!("io:{relative}: {error}"))?;
        let size = bytes.len() as u64;
        if size > MAX_FILE_BYTES {
            return Err(format!("too_large:{relative}"));
        }
        total += size;
        if total > MAX_READ_BYTES {
            return Err(format!("too_large:batch over {MAX_READ_BYTES} bytes"));
        }
        out.push(if as_text {
            let text = String::from_utf8_lossy(&bytes);
            FolderFile {
                path: relative.clone(),
                text: Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()),
                data: None,
            }
        } else {
            FolderFile {
                path: relative.clone(),
                text: None,
                data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            }
        });
    }
    Ok(out)
}

/// Ask the student for a folder, and remember that they chose it.
#[tauri::command]
pub async fn folder_import_pick(
    app: AppHandle,
    roots: State<'_, ImportRoots>,
) -> Result<Option<String>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| format!("io:{error}"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("not_found:{error}"))?;
    let canonical = fs::canonicalize(&path).map_err(|error| format!("not_found:{error}"))?;
    roots
        .0
        .lock()
        .map_err(|_| "io:import roots poisoned".to_owned())?
        .insert(canonical.clone());
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn folder_scan(
    roots: State<'_, ImportRoots>,
    root: String,
) -> Result<FolderManifest, String> {
    let root = granted_root(&roots, &root)?;
    tauri::async_runtime::spawn_blocking(move || scan(&root))
        .await
        .map_err(|error| format!("io:{error}"))
}

#[tauri::command]
pub async fn folder_read(
    roots: State<'_, ImportRoots>,
    root: String,
    paths: Vec<String>,
    text: bool,
) -> Result<Vec<FolderFile>, String> {
    let root = granted_root(&roots, &root)?;
    tauri::async_runtime::spawn_blocking(move || read(&root, &paths, text))
        .await
        .map_err(|error| format!("io:{error}"))?
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    /// A process-wide counter, not the clock: tests starting in the same tick
    /// would otherwise share a directory (the bug `db/notes.rs` found).
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn vault() -> TempDir {
        let root = std::env::temp_dir().join(format!(
            "notabene-folder-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("Physics/attachments")).unwrap();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join("Physics/Week 4.md"), "\u{feff}# Damping\n").unwrap();
        fs::write(root.join("Physics/attachments/spring.png"), [0u8, 1, 2]).unwrap();
        fs::write(root.join("Index.md"), "[[Week 4]]").unwrap();
        fs::write(root.join(".obsidian/app.json"), "{}").unwrap();
        TempDir(fs::canonicalize(root).unwrap())
    }

    #[test]
    fn the_manifest_lists_files_and_skips_dotfolders() {
        let dir = vault();
        let manifest = scan(&dir.0);
        let paths: Vec<_> = manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            paths,
            [
                "Index.md",
                "Physics/Week 4.md",
                "Physics/attachments/spring.png"
            ]
        );
        assert!(!manifest.truncated);
        assert!(manifest.files.iter().all(|file| file.modified_at.is_some()));
    }

    #[test]
    fn text_reads_drop_the_byte_order_mark_and_bytes_reads_are_base64() {
        let dir = vault();
        let text = read(&dir.0, &["Physics/Week 4.md".into()], true).unwrap();
        assert_eq!(text[0].text.as_deref(), Some("# Damping\n"));
        let bytes = read(&dir.0, &["Physics/attachments/spring.png".into()], false).unwrap();
        assert_eq!(bytes[0].data.as_deref(), Some("AAEC"));
    }

    #[test]
    fn a_read_cannot_leave_the_root() {
        let dir = vault();
        for escape in [
            "../etc/passwd",
            "/etc/passwd",
            "Physics/../../x",
            "./Index.md",
        ] {
            let error = read(&dir.0, &[escape.into()], true).unwrap_err();
            assert!(error.starts_with("outside_root:"), "{escape} -> {error}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_neither_walked_nor_read() {
        let dir = vault();
        std::os::unix::fs::symlink("/etc", dir.0.join("etc")).unwrap();
        std::os::unix::fs::symlink(dir.0.join("Index.md"), dir.0.join("Alias.md")).unwrap();
        let manifest = scan(&dir.0);
        assert!(manifest
            .files
            .iter()
            .all(|file| !file.path.starts_with("etc")));
        let reasons: Vec<_> = manifest
            .skipped
            .iter()
            .map(|skip| (skip.path.as_str(), skip.reason))
            .collect();
        assert!(reasons.contains(&("etc", "symlink")));
        assert!(reasons.contains(&("Alias.md", "symlink")));
        assert!(read(&dir.0, &["Alias.md".into()], true).is_err());
        assert!(read(&dir.0, &["etc/hosts".into()], true).is_err());
    }

    #[test]
    fn an_unpicked_root_is_refused() {
        let dir = vault();
        let roots = ImportRoots::default();
        let error = granted_root(&roots, &dir.0.to_string_lossy()).unwrap_err();
        assert!(error.starts_with("not_picked:"));
        roots.0.lock().unwrap().insert(dir.0.clone());
        assert!(granted_root(&roots, &dir.0.to_string_lossy()).is_ok());
    }
}
