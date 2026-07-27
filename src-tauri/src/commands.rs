//! Tauri commands — the IPC surface the TypeScript adapters call.
//!
//! Thin by design: parse, delegate to `db`, return. Anything resembling a
//! decision belongs in the TypeScript command layer, which is the code path
//! agent writes share with user writes.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::db::journal::{JournalEntry, PendingRecovery};
use crate::db::model::{
    Asset, Attachment, Course, Note, NoteQuery, NoteSummary, Section, Snapshot, SnapshotMeta,
    Tag,
};
use crate::db::{assets, journal, notes, organization, DbError, DbResult, Store};

/// Phases B–D fill these in. Returning a named error beats returning empty
/// data: a caller finds out immediately instead of concluding the library is
/// empty.
fn pending(feature: &str, phase: &str) -> DbError {
    DbError::Other(format!("{feature} lands in phase {phase}"))
}

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
pub fn library_list_sections(
    store: State<'_, Store>,
    course_id: String,
) -> DbResult<Vec<Section>> {
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
pub fn library_get_note(store: State<'_, Store>, note_id: String) -> DbResult<Option<Note>> {
    notes::get(&store, &note_id)
}

#[tauri::command]
pub fn library_upsert_note(store: State<'_, Store>, note: Note) -> DbResult<()> {
    notes::upsert(&store, &note)
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
) -> DbResult<Snapshot> {
    let id = format!("snap_{}", uuid_like());
    notes::create_snapshot(&store, &id, &note_id, &cause, &now())
}

#[tauri::command]
pub fn library_prune_snapshots(_store: State<'_, Store>, _note_id: String) -> DbResult<()> {
    // Retention thinning (hourly → daily → weekly) ships with the history
    // browser; until then every snapshot is kept, which errs the safe way.
    Ok(())
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
pub fn library_upsert_attachment(
    store: State<'_, Store>,
    attachment: Attachment,
) -> DbResult<()> {
    assets::upsert_attachment(&store, &attachment)
}

#[tauri::command]
pub fn library_delete_attachment(
    store: State<'_, Store>,
    attachment_id: String,
) -> DbResult<()> {
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
    if asset_id.len() < 2 || !asset_id.chars().all(|character| character.is_ascii_hexdigit()) {
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

#[tauri::command]
pub fn assets_collect_garbage(
    app: AppHandle,
    store: State<'_, Store>,
    referenced_ids: Vec<String>,
) -> DbResult<usize> {
    let removed = assets::collect_garbage(&store, &referenced_ids)?;
    for id in &removed {
        let path = asset_file_path(&app, id)?;
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(DbError::Other(error.to_string())),
        }
    }
    Ok(removed.len())
}

// -- not yet implemented -----------------------------------------------------

#[tauri::command]
pub fn library_list_saved_searches() -> DbResult<Value> {
    Err(pending("saved searches", "C"))
}

#[tauri::command]
pub fn library_list_templates() -> DbResult<Value> {
    Err(pending("templates", "C"))
}

#[tauri::command]
pub fn library_export() -> DbResult<Value> {
    Err(pending("library export", "D"))
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
