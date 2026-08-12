//! Tauri commands — the IPC surface the TypeScript adapters call.
//!
//! Thin by design: parse, delegate to `db`, return. Anything resembling a
//! decision belongs in the TypeScript command layer, which is the code path
//! agent writes share with user writes.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::db::journal::{JournalEntry, PendingRecovery};
use crate::db::model::{
    Asset, Attachment, Backlink, Course, Library, Note, NoteMatch, NoteQuery, NoteSummary,
    NoteTemplate, SavedSearch, Section, Snapshot, SnapshotMeta, Tag,
};
use crate::db::{
    assets, collections, journal, notes, organization, transfer, DbError, DbResult, Store,
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

fn asset_file_path(app: &AppHandle, asset_id: &str) -> DbResult<std::path::PathBuf> {
    if asset_id.len() < 2
        || !asset_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(DbError::Other("invalid asset id".into()));
    }
    Ok(crate::db::assets_path(app)?
        .join(&asset_id[..2])
        .join(asset_id))
}

#[tauri::command]
pub fn assets_put(
    app: AppHandle,
    store: State<'_, Store>,
    data: String,
    mime: String,
) -> DbResult<Asset> {
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

    let path = asset_file_path(&app, &id)?;
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
    app: AppHandle,
    store: State<'_, Store>,
    asset_id: String,
) -> DbResult<Option<AssetPayload>> {
    let Some(asset) = assets::stat(&store, &asset_id)? else {
        return Ok(None);
    };
    let bytes = std::fs::read(asset_file_path(&app, &asset_id)?)
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
    app: AppHandle,
    store: State<'_, Store>,
) -> DbResult<AssetGarbageResult> {
    let removed = assets::collect_garbage(&store)?;
    for (id, _) in &removed {
        let path = asset_file_path(&app, id)?;
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

fn export_parent_in_scope(app: &AppHandle, parent: &std::path::Path) -> DbResult<()> {
    let roots = [
        app.path().app_data_dir(),
        app.path().document_dir(),
        app.path().download_dir(),
        app.path().desktop_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    .filter_map(|root| std::fs::canonicalize(root).ok())
    .collect::<Vec<_>>();

    // Validate before creating anything. The nearest existing ancestor exposes
    // both `..` traversal and symlinks that would otherwise escape a permitted
    // root after `create_dir_all` had already mutated the filesystem.
    let existing = parent
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .ok_or_else(|| DbError::Other("export destination has no existing ancestor".into()))?;
    let canonical_existing = std::fs::canonicalize(existing)
        .map_err(|error| DbError::Other(format!("invalid export destination: {error}")))?;
    if !roots
        .iter()
        .any(|root| canonical_existing.starts_with(root))
    {
        return Err(DbError::Other(
            "EXPORT_DESTINATION_OUT_OF_SCOPE: exports may only be written to app data, Documents, Downloads, or Desktop".into(),
        ));
    }

    std::fs::create_dir_all(parent).map_err(|error| DbError::Other(error.to_string()))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| DbError::Other(format!("invalid export destination: {error}")))?;
    if roots.iter().any(|root| canonical_parent.starts_with(root)) {
        Ok(())
    } else {
        Err(DbError::Other(
            "EXPORT_DESTINATION_OUT_OF_SCOPE: export path escaped its permitted root".into(),
        ))
    }
}

#[tauri::command]
pub fn export_write(app: AppHandle, request: ExportRequest) -> DbResult<ExportResult> {
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
    let path = std::path::PathBuf::from(&destination);
    if let Some(parent) = path.parent() {
        export_parent_in_scope(&app, parent)?;
    }
    let temporary = path.with_extension("notabene-tmp");
    std::fs::write(&temporary, bytes).map_err(|error| DbError::Other(error.to_string()))?;
    std::fs::rename(&temporary, &path).map_err(|error| DbError::Other(error.to_string()))?;
    Ok(ExportResult {
        ok: true,
        path: Some(destination),
        error: None,
    })
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
