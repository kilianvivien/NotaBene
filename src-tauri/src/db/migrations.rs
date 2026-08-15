//! Schema versioning.
//!
//! `user_version` is the ladder. Step 0 → 1 applies `schema.sql`; later steps
//! are added as `ALTER`/backfill blocks. Migrations run inside a transaction,
//! so a failure leaves the database at the version it started on rather than
//! half-migrated.

use super::{DbResult, Store};

/// Must match `SCHEMA_VERSION` in `src/lib/schema/schema.ts`.
pub const SCHEMA_VERSION: i64 = 7;

const V1: &str = include_str!("schema.sql");
const V2: &str = r#"
DROP TRIGGER IF EXISTS notes_fts_insert;
DROP TRIGGER IF EXISTS notes_fts_delete;
DROP TRIGGER IF EXISTS notes_fts_update;
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    plain_text,
    tags,
    course,
    attachments,
    tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO notes_fts(rowid, title, plain_text, tags, course, attachments)
SELECT n.rowid,
       n.title,
       n.plain_text,
       COALESCE((
           SELECT group_concat(
               CASE WHEN t.namespace IS NULL THEN t.name
                    ELSE t.namespace || ':' || t.name END,
               ' '
           )
           FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
           WHERE nt.note_id = n.id
       ), ''),
       COALESCE((SELECT c.name FROM courses c WHERE c.id = n.course_id), ''),
       COALESCE((
           SELECT group_concat(a.name, ' ')
           FROM attachments a
           WHERE a.note_id = n.id
       ), '')
FROM notes n;

CREATE TABLE IF NOT EXISTS template_tags (
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (template_id, tag_id)
);
"#;

const V3: &str = r#"
ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT '#9b5c2f';
"#;

const V4: &str = r#"
ALTER TABLE snapshots ADD COLUMN run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);
"#;

const V5: &str = r#"
ALTER TABLE attachments ADD COLUMN annotations_json TEXT NOT NULL DEFAULT '[]';
"#;

const V6: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    details           TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'todo',
    priority          TEXT NOT NULL DEFAULT 'none',
    -- A task outlives its course: deleting a course leaves the assignment
    -- standing, unfiled, rather than destroying a deadline.
    course_id         TEXT REFERENCES courses(id) ON DELETE SET NULL,
    -- Subtasks are one level deep, enforced in the command layer. Cascade is
    -- right here: a purged parent has no orphans worth keeping.
    parent_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    due_at            TEXT,
    remind_at         TEXT,
    reminded_at       TEXT,
    recurrence_json   TEXT,
    completed_at      TEXT,
    last_completed_at TEXT,
    trashed_at        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    "order"           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_course ON tasks(course_id, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_trashed ON tasks(trashed_at);
-- Partial: the reminder sweep runs every 30 seconds and only ever asks about
-- tasks that actually carry one.
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at)
    WHERE remind_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);

CREATE TABLE IF NOT EXISTS task_notes (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    -- 'manual' rows are the student's; 'mention' rows are derived from the
    -- note's document and rebuilt on every save.
    origin  TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (task_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_task_notes_note ON task_notes(note_id);

-- Tasks get their own index rather than joining `notes_fts`: that table's
-- columns are note-shaped, and widening it would break ranking parity.
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
    title,
    details,
    course,
    tokenize = "unicode61 remove_diacritics 2"
);
"#;

const V7: &str = r#"
ALTER TABLE attachments ADD COLUMN url TEXT;
ALTER TABLE attachments ADD COLUMN fetched_at TEXT;
"#;

pub fn run(store: &Store) -> DbResult<()> {
    let current: i64 = store.with(|connection| {
        Ok(connection.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    })?;

    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    store.transact(|transaction| {
        if current < 1 {
            transaction.execute_batch(V1)?;
        }
        if current < 2 {
            transaction.execute_batch(V2)?;
        }
        if current < 3 {
            let has_color = transaction.query_row(
                "SELECT count(*) FROM pragma_table_info('tags') WHERE name = 'color'",
                [],
                |row| row.get::<_, i64>(0),
            )? > 0;
            if !has_color {
                transaction.execute_batch(V3)?;
            }
        }
        if current < 4 {
            let has_run_id = transaction.query_row(
                "SELECT count(*) FROM pragma_table_info('snapshots') WHERE name = 'run_id'",
                [],
                |row| row.get::<_, i64>(0),
            )? > 0;
            if !has_run_id {
                transaction.execute_batch(V4)?;
            }
        }
        if current < 5 {
            let has_annotations = transaction.query_row(
                "SELECT count(*) FROM pragma_table_info('attachments') WHERE name = 'annotations_json'",
                [],
                |row| row.get::<_, i64>(0),
            )? > 0;
            if !has_annotations {
                transaction.execute_batch(V5)?;
            }
        }
        if current < 6 {
            // Every statement in V6 is `IF NOT EXISTS`, so unlike the `ALTER`
            // steps above this one needs no `pragma_table_info` probe.
            transaction.execute_batch(V6)?;
        }
        if current < 7 {
            let has_url = transaction.query_row(
                "SELECT count(*) FROM pragma_table_info('attachments') WHERE name = 'url'",
                [],
                |row| row.get::<_, i64>(0),
            )? > 0;
            if !has_url {
                transaction.execute_batch(V7)?;
            }
        }
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    })
}

/// A library opened because another Mac owns its lock cannot be migrated: that
/// would make "read-only" a label rather than a boundary. It still has to be
/// the schema this build understands, or reads could be subtly wrong.
pub fn validate_current(store: &Store) -> DbResult<()> {
    let current: i64 = store.with(|connection| {
        Ok(connection.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    })?;
    if current == SCHEMA_VERSION {
        Ok(())
    } else {
        Err(super::DbError::Other(format!(
            "library schema v{current} requires writable migration to v{SCHEMA_VERSION}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc, Mutex};

    use rusqlite::Connection;

    use super::{run, SCHEMA_VERSION, V1, V2, V3};
    use crate::db::Store;

    /// "Must match" in the doc comment above is only true if something checks.
    /// Reading the TypeScript source is blunt, but it is the cheapest way to
    /// make a half-migration — Rust bumped, Zod not — fail in CI.
    #[test]
    fn schema_version_matches_the_typescript_contract() {
        const CONTRACT: &str = include_str!("../../../src/lib/schema/schema.ts");
        let declared = CONTRACT
            .lines()
            .find_map(|line| line.trim().strip_prefix("export const SCHEMA_VERSION = "))
            .and_then(|rest| rest.trim_end_matches(';').parse::<i64>().ok())
            .expect("could not find SCHEMA_VERSION in schema.ts");

        assert_eq!(
            declared, SCHEMA_VERSION,
            "schema.ts and migrations.rs disagree about the schema version"
        );
    }

    #[test]
    fn v2_database_gains_a_default_tag_color() {
        let connection = Connection::open_in_memory().expect("failed to open database");
        connection.execute_batch(V1).expect("failed to apply v1");
        connection.execute_batch(V2).expect("failed to apply v2");
        connection
            .execute(
                "INSERT INTO tags (id, namespace, name) VALUES ('tag-1', NULL, 'Important')",
                [],
            )
            .expect("failed to seed tag");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("failed to set schema version");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };

        run(&store).expect("failed to migrate");

        let color: String = store
            .with(|database| {
                Ok(
                    database.query_row("SELECT color FROM tags WHERE id = 'tag-1'", [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("failed to read migrated tag");
        assert_eq!(color, "#9b5c2f");
    }

    #[test]
    fn v3_database_gains_nullable_agent_run_ids() {
        let connection = Connection::open_in_memory().expect("failed to open database");
        connection.execute_batch(V1).expect("failed to apply v1");
        connection.execute_batch(V2).expect("failed to apply v2");
        connection.execute_batch(V3).expect("failed to apply v3");
        connection
            .pragma_update(None, "user_version", 3)
            .expect("failed to set schema version");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };

        run(&store).expect("failed to migrate");

        let has_run_id: i64 = store
            .with(|database| {
                Ok(database.query_row(
                    "SELECT count(*) FROM pragma_table_info('snapshots') WHERE name = 'run_id'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("failed to inspect migrated snapshots");
        assert_eq!(has_run_id, 1);
    }

    #[test]
    fn v4_database_gains_an_empty_pdf_annotation_layer() {
        let connection = Connection::open_in_memory().expect("failed to open database");
        connection
            .execute_batch(
                "CREATE TABLE attachments (
                    id TEXT PRIMARY KEY,
                    note_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                INSERT INTO attachments VALUES (
                    'attachment-1', 'note-1', 'asset-1', 'paper.pdf',
                    '2026-08-12T08:00:00Z'
                );",
            )
            .expect("failed to seed v4 attachments");
        connection
            .pragma_update(None, "user_version", 4)
            .expect("failed to set schema version");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };

        run(&store).expect("failed to migrate");

        let annotations: String = store
            .with(|database| {
                Ok(database.query_row(
                    "SELECT annotations_json FROM attachments WHERE id = 'attachment-1'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("failed to read migrated attachment");
        assert_eq!(annotations, "[]");
    }

    #[test]
    fn v5_database_gains_tasks_and_their_note_links() {
        let connection = Connection::open_in_memory().expect("failed to open database");
        // `schema.sql` has drifted ahead of v1 — it already carries the columns
        // V4 and V5 add — so the ladder stops at V3 and the version is stamped.
        // Replaying V4/V5 here would fail on a duplicate column, which is the
        // very thing `run`'s probes exist to avoid.
        for step in [V1, V2, V3] {
            connection.execute_batch(step).expect("failed to apply step");
        }
        connection
            .pragma_update(None, "user_version", 5)
            .expect("failed to set schema version");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };

        run(&store).expect("failed to migrate");

        // A round-trip through the new tables proves the columns, the foreign
        // keys and the FTS index all landed, which counting tables would not.
        store
            .with(|database| {
                database.execute_batch(
                    "INSERT INTO notes (id, title, doc_json, created_at, updated_at)
                     VALUES ('note-1', 'Lecture 4', '{}', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');
                     INSERT INTO tasks (id, title, created_at, updated_at)
                     VALUES ('task-1', 'Problem set 3', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');
                     INSERT INTO task_notes (task_id, note_id, origin)
                     VALUES ('task-1', 'note-1', 'mention');
                     INSERT INTO tasks_fts (rowid, title, details, course)
                     VALUES (1, 'Problem set 3', '', 'Analysis');",
                )?;
                Ok(())
            })
            .expect("failed to seed migrated tables");

        let (status, origin, matches): (String, String, i64) = store
            .with(|database| {
                let status = database.query_row(
                    "SELECT status FROM tasks WHERE id = 'task-1'",
                    [],
                    |row| row.get(0),
                )?;
                let origin = database.query_row(
                    "SELECT origin FROM task_notes WHERE task_id = 'task-1'",
                    [],
                    |row| row.get(0),
                )?;
                let matches = database.query_row(
                    "SELECT count(*) FROM tasks_fts WHERE tasks_fts MATCH 'problem'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((status, origin, matches))
            })
            .expect("failed to read migrated tasks");

        assert_eq!(status, "todo");
        assert_eq!(origin, "mention");
        assert_eq!(matches, 1);
    }

    #[test]
    fn v6_database_gains_the_link_columns_on_attachments() {
        let connection = Connection::open_in_memory().expect("failed to open database");
        for step in [V1, V2, V3] {
            connection.execute_batch(step).expect("failed to apply step");
        }
        connection
            .pragma_update(None, "user_version", 6)
            .expect("failed to set schema version");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };

        run(&store).expect("failed to migrate");

        // An existing attachment is a file, so it came from nowhere.
        let (url, fetched): (Option<String>, Option<String>) = store
            .with(|database| {
                database.execute_batch(
                    "INSERT INTO notes (id, title, doc_json, created_at, updated_at)
                     VALUES ('note-1', 'Lecture', '{}', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');
                     INSERT INTO assets (id, mime, bytes, created_at)
                     VALUES ('asset-1', 'application/pdf', 10, '2026-08-15T08:00:00Z');
                     INSERT INTO attachments (id, note_id, asset_id, name, created_at)
                     VALUES ('a-1', 'note-1', 'asset-1', 'paper.pdf', '2026-08-15T08:00:00Z');",
                )?;
                Ok(database.query_row(
                    "SELECT url, fetched_at FROM attachments WHERE id = 'a-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .expect("failed to read migrated attachment");

        assert_eq!(url, None);
        assert_eq!(fetched, None);
    }

    /// Purging a task must not leave its subtasks behind, and deleting a course
    /// must not take its assignments with it. Both are `REFERENCES` clauses in
    /// V6 rather than command-layer code, so they belong in a migration test.
    #[test]
    fn v6_cascades_subtasks_but_spares_a_deleted_course() {
        let connection = Connection::open_in_memory().expect("failed to open database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("failed to enable foreign keys");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };
        run(&store).expect("failed to migrate");

        let (orphans, spared): (i64, Option<String>) = store
            .with(|database| {
                database.execute_batch(
                    "INSERT INTO courses (id, name, color, icon, created_at, updated_at)
                     VALUES ('course-1', 'Analysis', '#007aff', '📘', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');
                     INSERT INTO tasks (id, title, course_id, created_at, updated_at)
                     VALUES ('parent', 'Essay', 'course-1', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');
                     INSERT INTO tasks (id, title, parent_id, created_at, updated_at)
                     VALUES ('child', 'Outline', 'parent', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');
                     DELETE FROM courses WHERE id = 'course-1';",
                )?;
                let spared = database.query_row(
                    "SELECT course_id FROM tasks WHERE id = 'parent'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )?;
                database.execute_batch("DELETE FROM tasks WHERE id = 'parent';")?;
                let orphans =
                    database.query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))?;
                Ok((orphans, spared))
            })
            .expect("failed to exercise the cascades");

        assert_eq!(spared, None, "a deleted course should unfile its tasks");
        assert_eq!(orphans, 0, "a purged parent should take its subtasks");
    }
}
