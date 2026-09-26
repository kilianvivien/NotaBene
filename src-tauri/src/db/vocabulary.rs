//! Course vocabulary: the words a student curated for completion, and the note
//! text the rest of it is harvested from.
//!
//! Only the curated half is stored. What the completer derives from the notes
//! is rebuilt on demand in TypeScript and never persisted — a cache that could
//! drift from the notes it summarises would be a second source of truth.

use rusqlite::Connection;

use super::model::{CourseTerm, NoteText};
use super::{DbResult, Store};

/// Cap on notes read for one harvest. A course with more than this is rare,
/// and past it the vocabulary has long since stopped changing.
const MAX_NOTE_TEXTS: i64 = 5_000;

/// Live and archived notes, never trashed ones: an archived lecture is still
/// the course's vocabulary, a trashed one is something the student threw out.
/// `None` reads the whole library, for notes that have no course.
pub fn list_note_texts(store: &Store, course_id: Option<&str>) -> DbResult<Vec<NoteText>> {
    store.with(|connection| {
        let sql = match course_id {
            Some(_) => {
                "SELECT id, title, plain_text FROM notes
                 WHERE trashed_at IS NULL AND course_id = ?1
                 ORDER BY updated_at DESC LIMIT ?2"
            }
            None => {
                "SELECT id, title, plain_text FROM notes
                 WHERE trashed_at IS NULL
                 ORDER BY updated_at DESC LIMIT ?2"
            }
        };
        let mut statement = connection.prepare(sql)?;
        let map = |row: &rusqlite::Row<'_>| {
            Ok(NoteText {
                id: row.get(0)?,
                title: row.get(1)?,
                plain_text: row.get(2)?,
            })
        };
        let rows = match course_id {
            Some(id) => statement
                .query_map(rusqlite::params![id, MAX_NOTE_TEXTS], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => {
                // `?1` is unused here, but binding by position keeps one
                // statement shape for both arms.
                statement
                    .query_map(rusqlite::params![rusqlite::types::Null, MAX_NOTE_TEXTS], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    })
}

/// One course's terms, or every course's when `course_id` is `None`.
pub fn list_course_terms(store: &Store, course_id: Option<&str>) -> DbResult<Vec<CourseTerm>> {
    store.with(|connection| match course_id {
        Some(id) => list_where(connection, "WHERE course_id = ?1", Some(id)),
        None => list_where(connection, "", None),
    })
}

pub(crate) fn list_all_course_terms_in(connection: &Connection) -> DbResult<Vec<CourseTerm>> {
    list_where(connection, "", None)
}

fn list_where(
    connection: &Connection,
    filter: &str,
    course_id: Option<&str>,
) -> DbResult<Vec<CourseTerm>> {
    let sql = format!(
        "SELECT id, course_id, term, status, source, created_at FROM course_terms {filter}
         ORDER BY term COLLATE NOCASE"
    );
    let mut statement = connection.prepare(&sql)?;
    let map = |row: &rusqlite::Row<'_>| {
        Ok(CourseTerm {
            id: row.get(0)?,
            course_id: row.get(1)?,
            term: row.get(2)?,
            status: row.get(3)?,
            source: row.get(4)?,
            created_at: row.get(5)?,
        })
    };
    let rows = match course_id {
        Some(id) => statement
            .query_map([id], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        None => statement
            .query_map([], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(rows)
}

pub fn upsert_course_term(store: &Store, term: &CourseTerm) -> DbResult<()> {
    store.with(|connection| upsert_course_term_in(connection, term))
}

/// `INSERT OR REPLACE` rather than `ON CONFLICT(id)`: a merge-import can bring
/// the same spelling for the same course under a different id, and that must
/// replace the row rather than fail the whole restore on the unique key.
pub(crate) fn upsert_course_term_in(connection: &Connection, term: &CourseTerm) -> DbResult<()> {
    connection.execute(
        "INSERT OR REPLACE INTO course_terms (id, course_id, term, status, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            term.id,
            term.course_id,
            term.term,
            term.status,
            term.source,
            term.created_at
        ],
    )?;
    Ok(())
}

pub fn delete_course_term(store: &Store, term_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM course_terms WHERE id = ?", [term_id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc, Mutex};

    use rusqlite::Connection;

    use super::*;
    use crate::db::migrations;

    fn store() -> Store {
        let connection = Connection::open_in_memory().expect("failed to open database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("failed to enable foreign keys");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };
        migrations::run(&store).expect("failed to migrate");
        store
            .with(|connection| {
                connection.execute_batch(
                    "INSERT INTO courses (id, name, color, created_at, updated_at)
                     VALUES ('bio', 'Biologie', '#336699', '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z');
                     INSERT INTO notes (id, course_id, title, doc_json, plain_text, created_at, updated_at)
                     VALUES ('n-1', 'bio', 'Cours 1', '{}', 'La mitochondrie produit l''ATP.', '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z');
                     INSERT INTO notes (id, course_id, title, doc_json, plain_text, trashed_at, created_at, updated_at)
                     VALUES ('n-2', 'bio', 'Jeté', '{}', 'brouillon', '2026-09-02T08:00:00Z', '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z');
                     INSERT INTO notes (id, title, doc_json, plain_text, created_at, updated_at)
                     VALUES ('n-3', 'Inbox', '{}', 'photosynthèse', '2026-09-01T08:00:00Z', '2026-09-01T08:00:00Z');",
                )?;
                Ok(())
            })
            .expect("failed to seed");
        store
    }

    fn term(id: &str, spelling: &str) -> CourseTerm {
        CourseTerm {
            id: id.into(),
            course_id: "bio".into(),
            term: spelling.into(),
            status: "accepted".into(),
            source: "user".into(),
            created_at: "2026-09-01T08:00:00Z".into(),
        }
    }

    #[test]
    fn note_texts_skip_trash_and_scope_to_the_course() {
        let store = store();
        let course = list_note_texts(&store, Some("bio")).expect("failed to list");
        assert_eq!(course.len(), 1);
        assert_eq!(course[0].plain_text, "La mitochondrie produit l'ATP.");

        let everything = list_note_texts(&store, None).expect("failed to list");
        assert_eq!(everything.len(), 2);
    }

    #[test]
    fn the_same_spelling_under_a_new_id_replaces_rather_than_fails() {
        let store = store();
        upsert_course_term(&store, &term("a", "mitochondrie")).expect("first insert");
        upsert_course_term(&store, &term("b", "mitochondrie")).expect("second insert");
        let terms = list_course_terms(&store, Some("bio")).expect("failed to list");
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].id, "b");

        delete_course_term(&store, "b").expect("failed to delete");
        assert!(list_course_terms(&store, None).expect("failed to list").is_empty());
    }
}
