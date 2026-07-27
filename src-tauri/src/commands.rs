//! Tauri commands — the IPC surface the TypeScript adapters call.
//!
//! Thin by design: parse, delegate to `db`, return. Anything resembling a
//! decision belongs in the TypeScript command layer, which is the code path
//! agent writes share with user writes.

use serde_json::Value;
use tauri::State;

use crate::db::model::{Course, Note, NoteQuery, NoteSummary, Section, Snapshot, SnapshotMeta, Tag};
use crate::db::{notes, organization, DbError, DbResult, Store};

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

// -- not yet implemented -----------------------------------------------------

#[tauri::command]
pub fn library_list_attachments(_note_id: String) -> DbResult<Value> {
    Err(pending("attachments", "B"))
}

#[tauri::command]
pub fn library_list_assets() -> DbResult<Value> {
    Err(pending("assets", "B"))
}

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
