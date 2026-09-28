//! Tauri commands — the IPC surface the TypeScript adapters call.
//!
//! Thin by design: parse, delegate to `db`, return. Anything resembling a
//! decision belongs in the TypeScript command layer, which is the code path
//! agent writes share with user writes.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::db::journal::{JournalEntry, PendingRecovery};
use crate::db::location::LibraryAccess;
use crate::db::model::{
    Asset, Attachment, Backlink, Course, CourseTerm, ImportedNote, Library, Note, NoteMatch,
    NoteQuery, NoteSummary, NoteTemplate, NoteText, NoteTitle, SavedSearch, Section, Snapshot,
    SnapshotMeta, Tag, Task, TaskNoteLink, TaskQuery,
};
use crate::db::{
    assets, collections, journal, notes, organization, tasks, transfer, vocabulary, DbError,
    DbResult, Store,
};

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// -- lifecycle ---------------------------------------------------------------

#[tauri::command]
pub fn library_init(store: State<'_, Store>) -> DbResult<()> {
    // Opening the store already ran migrations; this exists so the frontend has
    // one call that proves the database is reachable before it renders.
    store.with(|connection| {
        connection.query_row("SELECT 1", [], |_| Ok(()))?;
        Ok(())
    })
}

// -- courses & sections ------------------------------------------------------

#[tauri::command]
pub fn library_list_courses(store: State<'_, Store>) -> DbResult<Vec<Course>> {
    organization::list_courses(&store)
}

#[tauri::command]
pub fn library_upsert_course(store: State<'_, Store>, course: Course) -> DbResult<()> {
    organization::upsert_course(&store, &course)
}

#[tauri::command]
pub fn library_delete_course(store: State<'_, Store>, course_id: String) -> DbResult<()> {
    organization::delete_course(&store, &course_id)
}

#[tauri::command]
pub fn library_list_sections(store: State<'_, Store>, course_id: String) -> DbResult<Vec<Section>> {
    organization::list_sections(&store, &course_id)
}

#[tauri::command]
pub fn library_upsert_section(store: State<'_, Store>, section: Section) -> DbResult<()> {
    organization::upsert_section(&store, &section)
}

#[tauri::command]
pub fn library_delete_section(store: State<'_, Store>, section_id: String) -> DbResult<()> {
    organization::delete_section(&store, &section_id)
}

// -- notes -------------------------------------------------------------------

#[tauri::command]
pub fn library_query_notes(
    store: State<'_, Store>,
    query: NoteQuery,
) -> DbResult<Vec<NoteSummary>> {
    notes::query(&store, &query)
}

#[tauri::command]
pub fn library_count_notes(store: State<'_, Store>, query: NoteQuery) -> DbResult<i64> {
    notes::count(&store, &query)
}

/// The same query, scored. Retrieval's entry point — see `db::notes::search`.
#[tauri::command]
pub fn library_search_notes(store: State<'_, Store>, query: NoteQuery) -> DbResult<Vec<NoteMatch>> {
    notes::search(&store, &query)
}

#[tauri::command]
pub fn library_get_note(store: State<'_, Store>, note_id: String) -> DbResult<Option<Note>> {
    notes::get(&store, &note_id)
}

#[tauri::command]
pub fn library_upsert_note(store: State<'_, Store>, note: Note) -> DbResult<()> {
    notes::upsert(&store, &note)
}

/// Write a batch of notes in one transaction.
///
/// The webview chunks large imports before calling this; the whole point is
/// that each chunk is atomic and resolves its own cross-references, so the
/// chunk size is a payload decision rather than a correctness one.
#[tauri::command]
pub fn library_upsert_notes(store: State<'_, Store>, notes: Vec<Note>) -> DbResult<()> {
    notes::upsert_many(&store, &notes)
}

/// The note a bare `[[Title]]` points at. Shares its query with the backlink
/// index, so a link never navigates somewhere the inspector does not list.
#[tauri::command]
pub fn library_resolve_wiki_title(
    store: State<'_, Store>,
    title: String,
) -> DbResult<Option<String>> {
    notes::resolve_wiki_title(&store, &title)
}

/// The notes one importer wrote, for planning a re-import of the same source.
#[tauri::command]
pub fn library_list_imported_notes(
    store: State<'_, Store>,
    prefix: String,
) -> DbResult<Vec<ImportedNote>> {
    notes::list_imported(&store, &prefix)
}

#[tauri::command]
pub fn library_list_note_titles(store: State<'_, Store>) -> DbResult<Vec<NoteTitle>> {
    notes::list_titles(&store)
}

#[tauri::command]
pub fn library_upsert_note_if_unchanged(
    store: State<'_, Store>,
    note: Note,
    base_updated_at: String,
) -> DbResult<bool> {
    notes::upsert_if_unchanged(&store, &note, &base_updated_at)
}

#[tauri::command]
pub fn library_trash_note(store: State<'_, Store>, note_id: String) -> DbResult<()> {
    notes::set_trashed(&store, &note_id, Some(&now()))
}

#[tauri::command]
pub fn library_restore_note(store: State<'_, Store>, note_id: String) -> DbResult<()> {
    notes::set_trashed(&store, &note_id, None)
}

#[tauri::command]
pub fn library_purge_note(store: State<'_, Store>, note_id: String) -> DbResult<()> {
    notes::purge(&store, &note_id)
}

#[tauri::command]
pub fn library_list_backlinks(store: State<'_, Store>, note_id: String) -> DbResult<Vec<Backlink>> {
    notes::list_backlinks(&store, &note_id)
}

// -- tags --------------------------------------------------------------------

#[tauri::command]
pub fn library_list_tags(store: State<'_, Store>) -> DbResult<Vec<Tag>> {
    organization::list_tags(&store)
}

#[tauri::command]
pub fn library_upsert_tag(store: State<'_, Store>, tag: Tag) -> DbResult<()> {
    organization::upsert_tag(&store, &tag)
}

#[tauri::command]
pub fn library_delete_tag(store: State<'_, Store>, tag_id: String) -> DbResult<()> {
    organization::delete_tag(&store, &tag_id)
}

#[tauri::command]
pub fn library_merge_tags(
    store: State<'_, Store>,
    from_tag_id: String,
    into_tag_id: String,
) -> DbResult<()> {
    organization::merge_tags(&store, &from_tag_id, &into_tag_id)
}

// -- versions ----------------------------------------------------------------

#[tauri::command]
pub fn library_list_snapshots(
    store: State<'_, Store>,
    note_id: String,
) -> DbResult<Vec<SnapshotMeta>> {
    notes::list_snapshots(&store, &note_id)
}

#[tauri::command]
pub fn library_get_snapshot(
    store: State<'_, Store>,
    snapshot_id: String,
) -> DbResult<Option<Snapshot>> {
    notes::get_snapshot(&store, &snapshot_id)
}

#[tauri::command]
pub fn library_create_snapshot(
    store: State<'_, Store>,
    note_id: String,
    cause: String,
    run_id: Option<String>,
) -> DbResult<Snapshot> {
    let id = format!("snap_{}", uuid_like());
    notes::create_snapshot(&store, &id, &note_id, &cause, run_id.as_deref(), &now())
}

#[tauri::command]
pub fn library_prune_snapshots(
    store: State<'_, Store>,
    note_id: String,
    policy: SnapshotRetentionPolicy,
) -> DbResult<()> {
    notes::prune_snapshots(&store, &note_id, &policy)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRetentionPolicy {
    pub(crate) keep_all_days: f64,
    pub(crate) keep_hourly_days: f64,
    pub(crate) keep_daily_days: f64,
    #[serde(default)]
    pub(crate) forever: bool,
}

#[tauri::command]
pub fn library_purge_trash(store: State<'_, Store>, trashed_before: String) -> DbResult<usize> {
    notes::purge_trash(&store, &trashed_before)
}

// -- crash recovery ----------------------------------------------------------

#[tauri::command]
pub fn journal_write(store: State<'_, Store>, entry: JournalEntry) -> DbResult<()> {
    journal::write(&store, &entry)
}

#[tauri::command]
pub fn journal_pending(store: State<'_, Store>) -> DbResult<Vec<PendingRecovery>> {
    journal::pending(&store)
}

#[tauri::command]
pub fn journal_discard(store: State<'_, Store>, note_id: String) -> DbResult<()> {
    journal::discard(&store, &note_id)
}

// -- assets & attachments ----------------------------------------------------

#[tauri::command]
pub fn library_list_attachments(
    store: State<'_, Store>,
    note_id: String,
) -> DbResult<Vec<Attachment>> {
    assets::list_attachments(&store, &note_id)
}

#[tauri::command]
pub fn library_upsert_attachment(store: State<'_, Store>, attachment: Attachment) -> DbResult<()> {
    assets::upsert_attachment(&store, &attachment)
}

#[tauri::command]
pub fn library_delete_attachment(store: State<'_, Store>, attachment_id: String) -> DbResult<()> {
    assets::delete_attachment(&store, &attachment_id)
}

#[tauri::command]
pub fn library_list_assets(store: State<'_, Store>) -> DbResult<Vec<Asset>> {
    assets::list_assets(&store)
}

#[derive(Serialize)]
pub struct AssetPayload {
    data: String,
    mime: String,
}

pub(crate) fn asset_file_path(
    access: &LibraryAccess,
    asset_id: &str,
) -> DbResult<std::path::PathBuf> {
    if asset_id.len() < 2
        || !asset_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(DbError::Other("invalid asset id".into()));
    }
    Ok(access.assets_path().join(&asset_id[..2]).join(asset_id))
}

#[tauri::command]
pub fn assets_put(
    store: State<'_, Store>,
    access: State<'_, LibraryAccess>,
    data: String,
    mime: String,
) -> DbResult<Asset> {
    store.ensure_writable()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| DbError::Other(format!("invalid asset data: {error}")))?;
    let digest = Sha256::digest(&bytes);
    let id = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let asset = Asset {
        id: id.clone(),
        mime,
        bytes: i64::try_from(bytes.len())
            .map_err(|_| DbError::Other("asset is too large".into()))?,
        width: None,
        height: None,
        created_at: now(),
    };

    let path = asset_file_path(&access, &id)?;
    if !path.exists() {
        let parent = path
            .parent()
            .ok_or_else(|| DbError::Other("asset path has no parent".into()))?;
        std::fs::create_dir_all(parent).map_err(|error| DbError::Other(error.to_string()))?;
        let temporary = parent.join(format!(".{id}.tmp"));
        std::fs::write(&temporary, &bytes).map_err(|error| DbError::Other(error.to_string()))?;
        std::fs::rename(&temporary, &path).map_err(|error| DbError::Other(error.to_string()))?;
    }
    assets::upsert_asset(&store, &asset)?;
    Ok(asset)
}

#[tauri::command]
pub fn assets_get(
    store: State<'_, Store>,
    access: State<'_, LibraryAccess>,
    asset_id: String,
) -> DbResult<Option<AssetPayload>> {
    let Some(asset) = assets::stat(&store, &asset_id)? else {
        return Ok(None);
    };
    let bytes = std::fs::read(asset_file_path(&access, &asset_id)?)
        .map_err(|error| DbError::Other(error.to_string()))?;
    Ok(Some(AssetPayload {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime: asset.mime,
    }))
}

#[tauri::command]
pub fn assets_stat(store: State<'_, Store>, asset_id: String) -> DbResult<Option<Asset>> {
    assets::stat(&store, &asset_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetGarbageResult {
    removed: usize,
    bytes: i64,
}

#[tauri::command]
pub fn assets_collect_garbage(
    store: State<'_, Store>,
    access: State<'_, LibraryAccess>,
) -> DbResult<AssetGarbageResult> {
    store.ensure_writable()?;
    let removed = assets::collect_garbage(&store)?;
    for (id, _) in &removed {
        let path = asset_file_path(&access, id)?;
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(DbError::Other(error.to_string())),
        }
    }
    Ok(AssetGarbageResult {
        removed: removed.len(),
        bytes: removed.iter().map(|(_, bytes)| bytes).sum(),
    })
}

#[tauri::command]
pub fn library_list_saved_searches(store: State<'_, Store>) -> DbResult<Vec<SavedSearch>> {
    collections::list_saved_searches(&store)
}

#[tauri::command]
pub fn library_upsert_saved_search(store: State<'_, Store>, search: SavedSearch) -> DbResult<()> {
    collections::upsert_saved_search(&store, &search)
}

#[tauri::command]
pub fn library_delete_saved_search(store: State<'_, Store>, search_id: String) -> DbResult<()> {
    collections::delete_saved_search(&store, &search_id)
}

// -- course vocabulary -------------------------------------------------------

#[tauri::command]
pub fn library_list_note_texts(
    store: State<'_, Store>,
    course_id: Option<String>,
) -> DbResult<Vec<NoteText>> {
    vocabulary::list_note_texts(&store, course_id.as_deref())
}

#[tauri::command]
pub fn library_list_course_terms(
    store: State<'_, Store>,
    course_id: Option<String>,
) -> DbResult<Vec<CourseTerm>> {
    vocabulary::list_course_terms(&store, course_id.as_deref())
}

#[tauri::command]
pub fn library_upsert_course_term(store: State<'_, Store>, term: CourseTerm) -> DbResult<()> {
    vocabulary::upsert_course_term(&store, &term)
}

#[tauri::command]
pub fn library_delete_course_term(store: State<'_, Store>, term_id: String) -> DbResult<()> {
    vocabulary::delete_course_term(&store, &term_id)
}

// -- tasks -------------------------------------------------------------------

#[tauri::command]
pub fn library_list_tasks(store: State<'_, Store>, query: TaskQuery) -> DbResult<Vec<Task>> {
    tasks::list(&store, &query)
}

#[tauri::command]
pub fn library_get_task(store: State<'_, Store>, task_id: String) -> DbResult<Option<Task>> {
    tasks::get(&store, &task_id)
}

#[tauri::command]
pub fn library_search_tasks(
    store: State<'_, Store>,
    text: String,
    limit: i64,
) -> DbResult<Vec<Task>> {
    tasks::search(&store, &text, limit)
}

#[tauri::command]
pub fn library_upsert_task(store: State<'_, Store>, task: Task) -> DbResult<()> {
    tasks::upsert(&store, &task)
}

#[tauri::command]
pub fn library_upsert_task_if_unchanged(
    store: State<'_, Store>,
    task: Task,
    base_updated_at: String,
) -> DbResult<bool> {
    tasks::upsert_if_unchanged(&store, &task, &base_updated_at)
}

#[tauri::command]
pub fn library_trash_tasks(store: State<'_, Store>, task_ids: Vec<String>) -> DbResult<()> {
    tasks::trash(&store, &task_ids, &now())
}

#[tauri::command]
pub fn library_restore_tasks(store: State<'_, Store>, task_ids: Vec<String>) -> DbResult<()> {
    tasks::restore(&store, &task_ids, &now())
}

#[tauri::command]
pub fn library_purge_trashed_tasks(
    store: State<'_, Store>,
    trashed_before: String,
) -> DbResult<i64> {
    tasks::purge_trashed(&store, &trashed_before)
}

#[tauri::command]
pub fn library_list_due_reminders(store: State<'_, Store>) -> DbResult<Vec<Task>> {
    tasks::list_due_reminders(&store, &now())
}

#[tauri::command]
pub fn library_list_task_note_links(store: State<'_, Store>) -> DbResult<Vec<TaskNoteLink>> {
    tasks::list_note_links(&store)
}

#[tauri::command]
pub fn library_set_task_note_links(
    store: State<'_, Store>,
    task_id: String,
    note_ids: Vec<String>,
) -> DbResult<()> {
    tasks::set_manual_note_links(&store, &task_id, &note_ids)
}

#[tauri::command]
pub fn library_list_templates(store: State<'_, Store>) -> DbResult<Vec<NoteTemplate>> {
    collections::list_templates(&store)
}

#[tauri::command]
pub fn library_upsert_template(store: State<'_, Store>, template: NoteTemplate) -> DbResult<()> {
    collections::upsert_template(&store, &template)
}

#[tauri::command]
pub fn library_delete_template(store: State<'_, Store>, template_id: String) -> DbResult<()> {
    collections::delete_template(&store, &template_id)
}

#[tauri::command]
pub fn library_export(store: State<'_, Store>) -> DbResult<Library> {
    transfer::export_library(&store)
}

#[tauri::command]
pub fn library_import(store: State<'_, Store>, library: Library, mode: String) -> DbResult<()> {
    transfer::import_library(&store, &library, &mode)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    path: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    destination: Option<String>,
    suggested_name: Option<String>,
    files: Vec<ExportPayload>,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Write one file where the student said, or into a folder NotaBene owns.
///
/// The destination must pass `Grants::writable` — a save-panel answer, the
/// exports or backups folder, or the chosen backup folder. Before the
/// 2026-09 review any path under app data, Documents, Downloads or Desktop
/// was accepted, which put the library database and every document the
/// student owns one webview call away from being overwritten.
#[tauri::command]
pub fn export_write(
    app: AppHandle,
    grants: State<'_, crate::grants::Grants>,
    request: ExportRequest,
) -> DbResult<ExportResult> {
    let Some(file) = request.files.first() else {
        return Ok(ExportResult {
            ok: false,
            path: None,
            error: Some("nothing to export".into()),
        });
    };
    if request.files.len() != 1 {
        return Ok(ExportResult {
            ok: false,
            path: None,
            error: Some("multi-file exports must be packaged before writing".into()),
        });
    }
    let destination = request
        .destination
        .or(request.suggested_name)
        .unwrap_or_else(|| file.path.clone());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file.data)
        .map_err(|error| DbError::Other(format!("invalid export data: {error}")))?;
    let path = grants
        .writable(&app, std::path::Path::new(&destination))
        .map_err(DbError::Other)?;
    let temporary = path.with_extension("notabene-tmp");
    write_new_file(&temporary, &bytes)?;
    std::fs::rename(&temporary, &path).map_err(|error| DbError::Other(error.to_string()))?;
    Ok(ExportResult {
        ok: true,
        path: Some(destination),
        error: None,
    })
}

/// Write a file that must not already exist, never through a symlink.
///
/// `create_new` is `O_EXCL`, which refuses an existing path — a symlink
/// planted at the temporary name included — rather than following it. A
/// regular file left by an interrupted export is ours and is replaced.
fn write_new_file(path: &std::path::Path, bytes: &[u8]) -> DbResult<()> {
    use std::io::Write;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(DbError::Other(format!(
                "refusing to write through {}",
                path.display()
            )));
        }
        std::fs::remove_file(path).map_err(|error| DbError::Other(error.to_string()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| DbError::Other(error.to_string()))?;
    file.write_all(bytes)
        .map_err(|error| DbError::Other(error.to_string()))
}

/// Not a UUID, just a collision-resistant id from the system RNG — the same
/// role nanoid plays on the TypeScript side.
fn uuid_like() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    (0..12)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}
