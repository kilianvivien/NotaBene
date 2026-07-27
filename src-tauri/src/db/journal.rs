//! The editor journal — the last line of defence against a lost keystroke.
//!
//! Autosave already bounds loss to five seconds (`editorStore.ts`). This table
//! bounds it much tighter: the editor writes in-flight document state here on
//! every keystroke batch, ahead of the debounced save. A row survives a force
//! quit, and at launch any row *newer than the note it belongs to* is offered
//! back to the user.
//!
//! `notes::upsert` deletes a note's journal row in the same transaction as the
//! save, so a row can only outlive a save by being newer than it.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{DbResult, Store};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub note_id: String,
    pub doc: Value,
    pub title: String,
    /// Minted by the webview, deliberately: it is compared against
    /// `notes.updated_at`, which the webview also mints. Two clocks and two
    /// timestamp formats would make that comparison a coin toss.
    pub written_at: String,
}

/// A journal row that outlived its note's last save, plus enough of the note
/// to describe the choice: "recover the version from 14:32, or keep the one
/// saved at 14:29?"
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecovery {
    pub note_id: String,
    pub doc: Value,
    pub title: String,
    pub written_at: String,
    pub note_title: String,
    pub note_updated_at: String,
}

pub fn write(store: &Store, entry: &JournalEntry) -> DbResult<()> {
    let doc_json = serde_json::to_string(&entry.doc)?;
    store.with(|connection| {
        connection.execute(
            "INSERT INTO editor_journal (note_id, doc_json, title, written_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(note_id) DO UPDATE SET \
             doc_json = excluded.doc_json, title = excluded.title, \
             written_at = excluded.written_at",
            params![entry.note_id, doc_json, entry.title, entry.written_at],
        )?;
        Ok(())
    })
}

/// Rows worth offering back. Trashed notes are excluded — recovering into the
/// bin would be an odd thing to prompt someone with at launch.
pub fn pending(store: &Store) -> DbResult<Vec<PendingRecovery>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT j.note_id, j.doc_json, j.title, j.written_at, n.title, n.updated_at \
             FROM editor_journal j JOIN notes n ON n.id = j.note_id \
             WHERE j.written_at > n.updated_at AND n.trashed_at IS NULL \
             ORDER BY j.written_at DESC",
        )?;

        let rows = statement
            .query_map([], |row| {
                let doc_json: String = row.get(1)?;
                Ok((
                    row.get::<_, String>(0)?,
                    doc_json,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        rows.into_iter()
            .map(
                |(note_id, doc_json, title, written_at, note_title, note_updated_at)| {
                    Ok(PendingRecovery {
                        note_id,
                        doc: serde_json::from_str(&doc_json)?,
                        title,
                        written_at,
                        note_title,
                        note_updated_at,
                    })
                },
            )
            .collect()
    })
}

pub fn discard(store: &Store, note_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM editor_journal WHERE note_id = ?", [note_id])?;
        Ok(())
    })
}
