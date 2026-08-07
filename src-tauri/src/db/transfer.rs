//! Whole-library export and import — the two operations behind backup and
//! restore.
//!
//! Import is the single most destructive thing the app can do, so it is the one
//! place where "all or nothing" is not a nicety. Replace mode empties thirteen
//! tables; if anything after that failed, the previous shape of this code left
//! the student with an emptied library and a partial restore, because the wipe
//! committed on its own and each re-insert opened a transaction of its own.
//! Everything now runs inside one transaction, which is why every write below
//! goes through a `*_in` helper that takes the transaction's connection rather
//! than re-locking the store.

use super::migrations::SCHEMA_VERSION;
use super::model::Library;
use super::{assets, collections, notes, organization, DbError, DbResult, Store};

pub fn export_library(store: &Store) -> DbResult<Library> {
    let courses = organization::list_courses(store)?;
    let sections = organization::list_all_sections(store)?;

    // The daily backup path must stay proportional to the library, not to the
    // number of notes and versions. Read each table once (plus one tag join)
    // under the same connection instead of issuing three queries per note.
    let (exported_notes, attachments, snapshots, exported_assets) = store.with(|connection| {
        Ok((
            notes::list_all_in(connection)?,
            assets::list_all_attachments_in(connection)?,
            notes::list_all_snapshots_in(connection)?,
            assets::list_assets_in(connection)?,
        ))
    })?;

    Ok(Library {
        schema_version: SCHEMA_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        courses,
        sections,
        notes: exported_notes,
        tags: organization::list_tags(store)?,
        assets: exported_assets,
        attachments,
        snapshots,
        saved_searches: collections::list_saved_searches(store)?,
        templates: collections::list_templates(store)?,
    })
}

pub fn import_library(store: &Store, library: &Library, mode: &str) -> DbResult<()> {
    if mode != "replace" && mode != "merge" {
        return Err(DbError::Other(format!("invalid import mode {mode}")));
    }
    // Migration is the TypeScript layer's job — `safeImportLibrary` walks the
    // ladder before anything reaches here — so an unmigrated library is a bug
    // upstream and gets refused rather than guessed at.
    if library.schema_version != SCHEMA_VERSION {
        return Err(DbError::Other(format!(
            "library schema v{} was not migrated to v{}",
            library.schema_version, SCHEMA_VERSION
        )));
    }

    store.transact(|transaction| {
        if mode == "replace" {
            transaction.execute_batch(
                "DELETE FROM editor_journal;
                 DELETE FROM note_links;
                 DELETE FROM template_tags;
                 DELETE FROM note_tags;
                 DELETE FROM attachments;
                 DELETE FROM snapshots;
                 DELETE FROM templates;
                 DELETE FROM saved_searches;
                 DELETE FROM notes;
                 DELETE FROM notes_fts;
                 DELETE FROM sections;
                 DELETE FROM courses;
                 DELETE FROM tags;
                 DELETE FROM assets;",
            )?;
        }

        for course in &library.courses {
            organization::upsert_course_in(transaction, course)?;
        }
        for section in &library.sections {
            organization::upsert_section_in(transaction, section)?;
        }
        for tag in &library.tags {
            organization::upsert_tag_in(transaction, tag)?;
        }
        for asset in &library.assets {
            assets::upsert_asset_in(transaction, asset)?;
        }
        for note in &library.notes {
            notes::upsert_in(transaction, note)?;
        }
        for attachment in &library.attachments {
            assets::upsert_attachment_in(transaction, attachment)?;
        }
        for snapshot in &library.snapshots {
            notes::upsert_snapshot_in(transaction, snapshot)?;
        }
        for search in &library.saved_searches {
            collections::upsert_saved_search_in(transaction, search)?;
        }
        for template in &library.templates {
            collections::upsert_template_in(transaction, template)?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::model::Note;

    struct TempStore {
        store: Store,
        directory: std::path::PathBuf,
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn temp_store(label: &str) -> TempStore {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before the epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("notabene-{label}-{unique}"));
        let store = Store::open(&directory.join("notabene.sqlite3"))
            .expect("failed to open the test store");
        TempStore { store, directory }
    }

    fn note(id: &str, course_id: Option<&str>) -> Note {
        Note {
            id: id.into(),
            course_id: course_id.map(Into::into),
            section_id: None,
            title: id.into(),
            doc: serde_json::json!({ "type": "doc", "content": [] }),
            plain_text: id.into(),
            tag_ids: Vec::new(),
            pinned: false,
            archived: false,
            trashed_at: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            order: 0,
        }
    }

    fn counts(store: &Store) -> (i64, i64) {
        store
            .with(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM notes", [], |row| row.get(0))?,
                    connection.query_row("SELECT count(*) FROM notes_fts", [], |row| row.get(0))?,
                ))
            })
            .expect("failed to count")
    }

    fn library_of(notes: Vec<Note>) -> Library {
        Library {
            schema_version: SCHEMA_VERSION,
            exported_at: "2026-01-01T00:00:00Z".into(),
            app_version: "test".into(),
            courses: Vec::new(),
            sections: Vec::new(),
            notes,
            tags: Vec::new(),
            assets: Vec::new(),
            attachments: Vec::new(),
            snapshots: Vec::new(),
            saved_searches: Vec::new(),
            templates: Vec::new(),
        }
    }

    /// The regression that matters most in this file. A replace-mode import
    /// that fails part way used to leave the library emptied, because the wipe
    /// had already committed by the time the failing row was reached.
    #[test]
    fn a_failed_replace_import_leaves_the_library_exactly_as_it_was() {
        let temporary = temp_store("import-rollback");
        let store = &temporary.store;
        for id in ["kept-1", "kept-2", "kept-3"] {
            notes::upsert(store, &note(id, None)).expect("failed to seed");
        }
        assert_eq!(counts(store), (3, 3));

        // The third note points at a course that does not exist. Foreign keys
        // are on, so it is refused — two notes into the re-insert.
        let incoming = library_of(vec![
            note("incoming-1", None),
            note("incoming-2", None),
            note("incoming-3", Some("no-such-course")),
        ]);

        let result = import_library(store, &incoming, "replace");

        assert!(result.is_err(), "the import should have been refused");
        assert_eq!(
            counts(store),
            (3, 3),
            "every original note, and its index row, must survive a failed restore"
        );
        let ids: Vec<String> = store
            .with(|connection| {
                let mut statement = connection.prepare("SELECT id FROM notes ORDER BY id")?;
                let rows = statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                Ok(rows)
            })
            .expect("failed to list notes");
        assert_eq!(ids, ["kept-1", "kept-2", "kept-3"]);
    }

    #[test]
    fn a_successful_replace_import_leaves_no_orphaned_index_rows() {
        let temporary = temp_store("import-replace");
        let store = &temporary.store;
        for id in ["old-1", "old-2", "old-3"] {
            notes::upsert(store, &note(id, None)).expect("failed to seed");
        }

        import_library(store, &library_of(vec![note("new-1", None)]), "replace")
            .expect("failed to import");

        assert_eq!(
            counts(store),
            (1, 1),
            "`notes_fts` stopped being an external-content table in v2, so the \
             replace batch has to clear it too — otherwise the index keeps every \
             note ever deleted and skews the bm25 ranking"
        );
    }

    #[test]
    fn merging_keeps_what_is_already_there() {
        let temporary = temp_store("import-merge");
        let store = &temporary.store;
        notes::upsert(store, &note("existing", None)).expect("failed to seed");

        import_library(store, &library_of(vec![note("incoming", None)]), "merge")
            .expect("failed to import");

        assert_eq!(counts(store), (2, 2));
    }

    #[test]
    fn purging_trash_takes_the_index_rows_with_it() {
        let temporary = temp_store("purge-trash");
        let store = &temporary.store;
        let mut trashed = note("trashed", None);
        trashed.trashed_at = Some("2026-01-01T00:00:00Z".into());
        notes::upsert(store, &trashed).expect("failed to seed");
        notes::upsert(store, &note("kept", None)).expect("failed to seed");
        assert_eq!(counts(store), (2, 2));

        let removed = notes::purge_trash(store, "2026-06-01T00:00:00Z").expect("failed to purge");

        assert_eq!(removed, 1);
        assert_eq!(
            counts(store),
            (1, 1),
            "the purged note's index row must go too"
        );
    }

    #[test]
    fn an_unmigrated_library_is_refused_rather_than_guessed_at() {
        let temporary = temp_store("import-version");
        let store = &temporary.store;
        let mut incoming = library_of(vec![note("incoming", None)]);
        incoming.schema_version = SCHEMA_VERSION - 1;

        let error = import_library(store, &incoming, "replace")
            .expect_err("an older schema must not be imported");

        assert!(error.to_string().contains("was not migrated"));
        assert_eq!(counts(store), (0, 0));
    }
}
