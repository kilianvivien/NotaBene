//! Task reads and writes, plus the links that tie a task to its notes.
//!
//! Shaped like `notes.rs` rather than `collections.rs`: tasks are queried by the
//! sidebar, filtered by course and status, ranked by a free-text index and
//! guarded by optimistic concurrency, so the same "compose one statement with
//! bound parameters" discipline applies.

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row};

use super::model::{Recurrence, Task, TaskNoteLink, TaskQuery};
use super::notes::{fts_match_expression, TextMatch};
use super::{DbResult, Store};

/// `bm25` column weights in schema order: title, details, course. A task title
/// is short and deliberate, so a hit there should outrank one buried in notes.
const BM25_WEIGHTS: [f64; 3] = [10.0, 1.0, 3.0];

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let recurrence_json: Option<String> = row.get("recurrence_json")?;
    let recurrence = match recurrence_json {
        Some(raw) => serde_json::from_str::<Recurrence>(&raw).map(Some).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        None => None,
    };
    Ok(Task {
        id: row.get("id")?,
        title: row.get("title")?,
        details: row.get("details")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        course_id: row.get("course_id")?,
        parent_id: row.get("parent_id")?,
        tag_ids: Vec::new(), // filled in by the caller, one query for all rows
        due_at: row.get("due_at")?,
        remind_at: row.get("remind_at")?,
        reminded_at: row.get("reminded_at")?,
        recurrence,
        completed_at: row.get("completed_at")?,
        last_completed_at: row.get("last_completed_at")?,
        trashed_at: row.get("trashed_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        order: row.get("order")?,
    })
}

const TASK_COLUMNS: &str = "t.id, t.title, t.details, t.status, t.priority, t.course_id, \
     t.parent_id, t.due_at, t.remind_at, t.reminded_at, t.recurrence_json, \
     t.completed_at, t.last_completed_at, t.trashed_at, t.created_at, \
     t.updated_at, t.\"order\"";

/// One extra query for every task's tags, rather than one per task.
fn attach_tags(connection: &Connection, mut tasks: Vec<Task>) -> DbResult<Vec<Task>> {
    if tasks.is_empty() {
        return Ok(tasks);
    }
    let mut statement =
        connection.prepare("SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id")?;
    for task in &mut tasks {
        task.tag_ids = statement
            .query_map([&task.id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(tasks)
}

fn build_task_query(query: &TaskQuery) -> (String, Vec<SqlValue>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<SqlValue> = Vec::new();

    match query.scope.as_deref() {
        Some("trashed") => clauses.push("t.trashed_at IS NOT NULL".into()),
        Some("all") => {}
        // `live` is the default: a task in Trash is not part of the workload.
        _ => clauses.push("t.trashed_at IS NULL".into()),
    }

    if let Some(statuses) = &query.status {
        if statuses.is_empty() {
            // An explicit empty filter means "nothing", not "everything".
            clauses.push("0".into());
        } else {
            let slots = vec!["?"; statuses.len()].join(", ");
            clauses.push(format!("t.status IN ({slots})"));
            for status in statuses {
                binds.push(SqlValue::Text(status.clone()));
            }
        }
    }

    // `Some(None)` is the honest question "which tasks are unfiled?", which is
    // why this is a double option — same reason `NoteQuery::course_id` is.
    match &query.course_id {
        Some(Some(course_id)) => {
            clauses.push("t.course_id = ?".into());
            binds.push(SqlValue::Text(course_id.clone()));
        }
        Some(None) => clauses.push("t.course_id IS NULL".into()),
        None => {}
    }

    match &query.parent_id {
        Some(Some(parent_id)) => {
            clauses.push("t.parent_id = ?".into());
            binds.push(SqlValue::Text(parent_id.clone()));
        }
        Some(None) => clauses.push("t.parent_id IS NULL".into()),
        None => {}
    }

    if let Some(note_id) = &query.note_id {
        clauses.push("EXISTS (SELECT 1 FROM task_notes tn WHERE tn.task_id = t.id AND tn.note_id = ?)".into());
        binds.push(SqlValue::Text(note_id.clone()));
    }

    if let Some(due_before) = &query.due_before {
        clauses.push("t.due_at IS NOT NULL AND t.due_at <= ?".into());
        binds.push(SqlValue::Text(due_before.clone()));
    }

    if let Some(text) = query.text.as_deref().filter(|value| !value.trim().is_empty()) {
        clauses.push(
            "t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?)".into(),
        );
        binds.push(SqlValue::Text(fts_match_expression(text, TextMatch::All)));
    }

    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    // A task with no due date is not "overdue by an infinite margin", so nulls
    // sort last in every date ordering rather than leading the list.
    let order = match query.sort.as_deref() {
        Some("created") => "t.created_at DESC",
        Some("updated") => "t.updated_at DESC",
        // Text order would put `none` above `high`; the CASE is what makes
        // "priority" mean priority.
        Some("priority") => {
            "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'low' THEN 2 ELSE 3 END, t.due_at IS NULL, t.due_at"
        }
        Some("manual") => "t.\"order\", t.due_at IS NULL, t.due_at",
        _ => "t.due_at IS NULL, t.due_at, t.\"order\", t.created_at",
    };

    let mut sql = format!("SELECT {TASK_COLUMNS} FROM tasks t{where_clause} ORDER BY {order}");
    if let Some(limit) = query.limit {
        sql.push_str(" LIMIT ?");
        binds.push(SqlValue::Integer(limit));
        if let Some(offset) = query.offset {
            sql.push_str(" OFFSET ?");
            binds.push(SqlValue::Integer(offset));
        }
    }
    (sql, binds)
}

pub fn list(store: &Store, query: &TaskQuery) -> DbResult<Vec<Task>> {
    store.with(|connection| {
        let (sql, binds) = build_task_query(query);
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(binds.iter()), row_to_task)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        attach_tags(connection, rows)
    })
}

pub fn get(store: &Store, task_id: &str) -> DbResult<Option<Task>> {
    store.with(|connection| get_in(connection, task_id))
}

pub(crate) fn get_in(connection: &Connection, task_id: &str) -> DbResult<Option<Task>> {
    let mut statement =
        connection.prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks t WHERE t.id = ?"))?;
    let task = statement.query_row([task_id], row_to_task).optional()?;
    match task {
        Some(task) => Ok(attach_tags(connection, vec![task])?.into_iter().next()),
        None => Ok(None),
    }
}

/// Ranked free-text search over `tasks_fts`.
pub fn search(store: &Store, text: &str, limit: i64) -> DbResult<Vec<Task>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    store.with(|connection| {
        let [title, details, course] = BM25_WEIGHTS;
        let mut statement = connection.prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks t
             JOIN tasks_fts f ON f.rowid = t.rowid
             WHERE tasks_fts MATCH ?1 AND t.trashed_at IS NULL
             ORDER BY -bm25(tasks_fts, {title}, {details}, {course}) DESC
             LIMIT ?2"
        ))?;
        let rows = statement
            .query_map(
                rusqlite::params![fts_match_expression(text, TextMatch::All), limit],
                row_to_task,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        attach_tags(connection, rows)
    })
}

/// Tasks whose reminder has come due and has not yet been delivered.
///
/// `reminded_at` rather than a timer is what makes a reminder fire exactly once
/// across a quit and relaunch — the sweep on startup is the same query as the
/// sweep thirty seconds later.
pub fn list_due_reminders(store: &Store, now: &str) -> DbResult<Vec<Task>> {
    store.with(|connection| {
        let mut statement = connection.prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks t
             WHERE t.remind_at IS NOT NULL AND t.remind_at <= ?
               AND t.reminded_at IS NULL
               AND t.status != 'done'
               AND t.trashed_at IS NULL
             ORDER BY t.remind_at"
        ))?;
        let rows = statement
            .query_map([now], row_to_task)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        attach_tags(connection, rows)
    })
}

pub fn upsert(store: &Store, task: &Task) -> DbResult<()> {
    store.transact(|transaction| upsert_in(transaction, task))
}

/// Replace a task only if the durable row is still the version the caller read.
/// Imports and the reminder sweep continue to use unconditional `upsert`.
pub fn upsert_if_unchanged(store: &Store, task: &Task, base_updated_at: &str) -> DbResult<bool> {
    store.transact(|transaction| {
        let recurrence_json = match &task.recurrence {
            Some(recurrence) => Some(serde_json::to_string(recurrence)?),
            None => None,
        };
        let changed = transaction.execute(
            "UPDATE tasks SET title = ?1, details = ?2, status = ?3, priority = ?4,
             course_id = ?5, parent_id = ?6, due_at = ?7, remind_at = ?8,
             reminded_at = ?9, recurrence_json = ?10, completed_at = ?11,
             last_completed_at = ?12, trashed_at = ?13, updated_at = ?14,
             \"order\" = ?15
             WHERE id = ?16 AND updated_at = ?17",
            rusqlite::params![
                task.title,
                task.details,
                task.status,
                task.priority,
                task.course_id,
                task.parent_id,
                task.due_at,
                task.remind_at,
                task.reminded_at,
                recurrence_json,
                task.completed_at,
                task.last_completed_at,
                task.trashed_at,
                task.updated_at,
                task.order,
                task.id,
                base_updated_at,
            ],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        replace_tags(transaction, task)?;
        reindex_task(transaction, &task.id)?;
        Ok(true)
    })
}

pub(crate) fn upsert_in(connection: &Connection, task: &Task) -> DbResult<()> {
    let recurrence_json = match &task.recurrence {
        Some(recurrence) => Some(serde_json::to_string(recurrence)?),
        None => None,
    };
    connection.execute(
        "INSERT INTO tasks (id, title, details, status, priority, course_id, \
         parent_id, due_at, remind_at, reminded_at, recurrence_json, completed_at, \
         last_completed_at, trashed_at, created_at, updated_at, \"order\") \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) \
         ON CONFLICT(id) DO UPDATE SET \
         title = excluded.title, details = excluded.details, status = excluded.status, \
         priority = excluded.priority, course_id = excluded.course_id, \
         parent_id = excluded.parent_id, due_at = excluded.due_at, \
         remind_at = excluded.remind_at, reminded_at = excluded.reminded_at, \
         recurrence_json = excluded.recurrence_json, completed_at = excluded.completed_at, \
         last_completed_at = excluded.last_completed_at, trashed_at = excluded.trashed_at, \
         updated_at = excluded.updated_at, \"order\" = excluded.\"order\"",
        rusqlite::params![
            task.id,
            task.title,
            task.details,
            task.status,
            task.priority,
            task.course_id,
            task.parent_id,
            task.due_at,
            task.remind_at,
            task.reminded_at,
            recurrence_json,
            task.completed_at,
            task.last_completed_at,
            task.trashed_at,
            task.created_at,
            task.updated_at,
            task.order,
        ],
    )?;
    replace_tags(connection, task)?;
    reindex_task(connection, &task.id)?;
    Ok(())
}

/// Replace rather than diff: the set is tiny and this cannot drift.
fn replace_tags(connection: &Connection, task: &Task) -> DbResult<()> {
    connection.execute("DELETE FROM task_tags WHERE task_id = ?", [&task.id])?;
    for tag_id in &task.tag_ids {
        connection.execute(
            "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![task.id, tag_id],
        )?;
    }
    Ok(())
}

/// Keep the search index in step with the row. Course renames call this too, so
/// a task becomes findable by its new course name without a full rebuild.
pub(crate) fn reindex_task(connection: &Connection, task_id: &str) -> DbResult<()> {
    let row = connection.query_row(
        "SELECT t.rowid, t.title, t.details,
                COALESCE((SELECT c.name FROM courses c WHERE c.id = t.course_id), '')
         FROM tasks t WHERE t.id = ?",
        [task_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    )?;
    connection.execute("DELETE FROM tasks_fts WHERE rowid = ?", [row.0])?;
    connection.execute(
        "INSERT INTO tasks_fts(rowid, title, details, course) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![row.0, row.1, row.2, row.3],
    )?;
    Ok(())
}

/// Move tasks to Trash, taking their subtasks with them.
///
/// The cascade lives here rather than in the command layer so it is atomic and
/// cannot drift between the two callers (the UI and the agent tools).
pub fn trash(store: &Store, task_ids: &[String], trashed_at: &str) -> DbResult<()> {
    store.transact(|transaction| {
        for task_id in task_ids {
            transaction.execute(
                "UPDATE tasks SET trashed_at = ?1, updated_at = ?1
                 WHERE (id = ?2 OR parent_id = ?2) AND trashed_at IS NULL",
                rusqlite::params![trashed_at, task_id],
            )?;
        }
        Ok(())
    })
}

pub fn restore(store: &Store, task_ids: &[String], updated_at: &str) -> DbResult<()> {
    store.transact(|transaction| {
        for task_id in task_ids {
            transaction.execute(
                "UPDATE tasks SET trashed_at = NULL, updated_at = ?1
                 WHERE id = ?2 OR parent_id = ?2",
                rusqlite::params![updated_at, task_id],
            )?;
            // A restored subtask whose parent is still in Trash would be
            // invisible in every view; lift the parent with it.
            transaction.execute(
                "UPDATE tasks SET trashed_at = NULL, updated_at = ?1
                 WHERE id = (SELECT parent_id FROM tasks WHERE id = ?2)",
                rusqlite::params![updated_at, task_id],
            )?;
        }
        Ok(())
    })
}

/// Delete tasks trashed before `cutoff`. The only permanent delete in this
/// module, and it is reachable from the app's Trash alone — never from MCP.
pub fn purge_trashed(store: &Store, cutoff: &str) -> DbResult<i64> {
    store.transact(|transaction| {
        let rowids: Vec<i64> = {
            let mut statement = transaction
                .prepare("SELECT rowid FROM tasks WHERE trashed_at IS NOT NULL AND trashed_at < ?")?;
            let rowids = statement
                .query_map([cutoff], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rowids
        };
        for rowid in &rowids {
            transaction.execute("DELETE FROM tasks_fts WHERE rowid = ?", [rowid])?;
        }
        let removed = transaction.execute(
            "DELETE FROM tasks WHERE trashed_at IS NOT NULL AND trashed_at < ?",
            [cutoff],
        )?;
        Ok(removed as i64)
    })
}

pub fn list_note_links(store: &Store) -> DbResult<Vec<TaskNoteLink>> {
    store.with(|connection| {
        let mut statement = connection
            .prepare("SELECT task_id, note_id, origin FROM task_notes ORDER BY task_id, note_id")?;
        let rows = statement
            .query_map([], |row| {
                Ok(TaskNoteLink {
                    task_id: row.get(0)?,
                    note_id: row.get(1)?,
                    origin: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Replace the `manual` links of one task. `mention` rows belong to the note's
/// document and are deliberately left alone.
pub fn set_manual_note_links(store: &Store, task_id: &str, note_ids: &[String]) -> DbResult<()> {
    store.transact(|transaction| set_manual_note_links_in(transaction, task_id, note_ids))
}

pub(crate) fn set_manual_note_links_in(
    connection: &Connection,
    task_id: &str,
    note_ids: &[String],
) -> DbResult<()> {
    connection.execute(
        "DELETE FROM task_notes WHERE task_id = ? AND origin = 'manual'",
        [task_id],
    )?;
    for note_id in note_ids {
        // A note that already mentions the task inline keeps that row and is
        // promoted to `manual`: the student's explicit link is the stronger
        // claim, and it must survive the chip being deleted from the prose.
        connection.execute(
            "INSERT INTO task_notes (task_id, note_id, origin) VALUES (?1, ?2, 'manual')
             ON CONFLICT(task_id, note_id) DO UPDATE SET origin = 'manual'",
            rusqlite::params![task_id, note_id],
        )?;
    }
    Ok(())
}

pub(crate) fn upsert_link_in(connection: &Connection, link: &TaskNoteLink) -> DbResult<()> {
    connection.execute(
        "INSERT INTO task_notes (task_id, note_id, origin) VALUES (?1, ?2, ?3)
         ON CONFLICT(task_id, note_id) DO UPDATE SET origin = excluded.origin",
        rusqlite::params![link.task_id, link.note_id, link.origin],
    )?;
    Ok(())
}

/// Rebuild the `mention` links a note's document implies.
///
/// This is `rebuild_links` for a second table: the document is the source of
/// truth for inline chips, so they are derived on every save rather than kept in
/// step by hand. `manual` rows are untouched, and a chip pointing at a task that
/// no longer exists is dropped rather than inserted.
pub(crate) fn rebuild_mentions_in(
    connection: &Connection,
    note_id: &str,
    doc: &serde_json::Value,
) -> DbResult<()> {
    connection.execute(
        "DELETE FROM task_notes WHERE note_id = ? AND origin = 'mention'",
        [note_id],
    )?;
    for task_id in mentioned_task_ids(doc) {
        connection.execute(
            "INSERT OR IGNORE INTO task_notes (task_id, note_id, origin)
             SELECT ?1, ?2, 'mention' WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?1)",
            rusqlite::params![task_id, note_id],
        )?;
    }
    Ok(())
}

fn mentioned_task_ids(doc: &serde_json::Value) -> Vec<String> {
    fn walk(node: &serde_json::Value, found: &mut Vec<String>) {
        if node.get("type").and_then(|value| value.as_str()) == Some("taskRef") {
            if let Some(task_id) = node
                .get("attrs")
                .and_then(|attrs| attrs.get("taskId"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
            {
                let task_id = task_id.to_owned();
                if !found.contains(&task_id) {
                    found.push(task_id);
                }
            }
        }
        if let Some(children) = node.get("content").and_then(|value| value.as_array()) {
            for child in children {
                walk(child, found);
            }
        }
    }

    let mut found = Vec::new();
    walk(doc, &mut found);
    found
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc, Mutex};

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::db::migrations;

    fn store() -> Store {
        let connection = Connection::open_in_memory().expect("failed to open database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("failed to enable foreign keys");
        let store = Store {
            connection: Arc::new(Mutex::new(connection)),
            read_only: Arc::new(AtomicBool::new(false)),
        };
        migrations::run(&store).expect("failed to migrate");
        store
    }

    fn task(id: &str, title: &str) -> Task {
        Task {
            id: id.to_owned(),
            title: title.to_owned(),
            details: String::new(),
            status: "todo".into(),
            priority: "none".into(),
            course_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            due_at: None,
            remind_at: None,
            reminded_at: None,
            recurrence: None,
            completed_at: None,
            last_completed_at: None,
            trashed_at: None,
            created_at: "2026-08-15T08:00:00Z".into(),
            updated_at: "2026-08-15T08:00:00Z".into(),
            order: 0,
        }
    }

    #[test]
    fn round_trips_a_task_with_its_recurrence() {
        let store = store();
        let mut seeded = task("task-1", "Problem set 3");
        seeded.recurrence = Some(Recurrence {
            freq: "weekly".into(),
            interval: 1,
            weekdays: vec![2, 4],
        });
        upsert(&store, &seeded).expect("failed to write task");

        let read = get(&store, "task-1")
            .expect("failed to read task")
            .expect("task should exist");
        let recurrence = read.recurrence.expect("recurrence should survive the round trip");
        assert_eq!(recurrence.freq, "weekly");
        assert_eq!(recurrence.weekdays, vec![2, 4]);
    }

    #[test]
    fn refuses_a_write_whose_base_version_moved() {
        let store = store();
        upsert(&store, &task("task-1", "Essay")).expect("failed to write task");

        let mut edit = task("task-1", "Essay, revised");
        edit.updated_at = "2026-08-15T09:00:00Z".into();
        let landed = upsert_if_unchanged(&store, &edit, "2026-08-15T08:00:00Z")
            .expect("failed to attempt write");
        assert!(landed, "a write from the current version should land");

        let mut stale = task("task-1", "Essay, from a stale reader");
        stale.updated_at = "2026-08-15T10:00:00Z".into();
        let landed = upsert_if_unchanged(&store, &stale, "2026-08-15T08:00:00Z")
            .expect("failed to attempt write");
        assert!(!landed, "a write from a stale version must be refused");

        let read = get(&store, "task-1").expect("failed to read").expect("exists");
        assert_eq!(read.title, "Essay, revised");
    }

    #[test]
    fn trashing_a_parent_takes_its_subtasks_and_restoring_lifts_them_back() {
        let store = store();
        upsert(&store, &task("parent", "Essay")).expect("failed to write parent");
        let mut child = task("child", "Outline");
        child.parent_id = Some("parent".into());
        upsert(&store, &child).expect("failed to write child");

        trash(&store, &["parent".to_owned()], "2026-08-15T12:00:00Z").expect("failed to trash");
        let live = list(&store, &TaskQuery::default()).expect("failed to list");
        assert!(live.is_empty(), "trashing a parent should hide its subtasks too");

        restore(&store, &["parent".to_owned()], "2026-08-15T13:00:00Z").expect("failed to restore");
        let live = list(&store, &TaskQuery::default()).expect("failed to list");
        assert_eq!(live.len(), 2);
    }

    #[test]
    fn finds_a_task_by_title_ignoring_diacritics() {
        let store = store();
        let mut seeded = task("task-1", "Résumé de cours");
        seeded.details = "Chapitre 4".into();
        upsert(&store, &seeded).expect("failed to write task");

        let hits = search(&store, "resume", 10).expect("failed to search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "task-1");
    }

    #[test]
    fn a_reminder_is_due_once_and_not_again_after_delivery() {
        let store = store();
        let mut seeded = task("task-1", "Hand in essay");
        seeded.remind_at = Some("2026-08-15T07:00:00Z".into());
        upsert(&store, &seeded).expect("failed to write task");

        let due = list_due_reminders(&store, "2026-08-15T08:00:00Z").expect("failed to sweep");
        assert_eq!(due.len(), 1);

        seeded.reminded_at = Some("2026-08-15T08:00:00Z".into());
        upsert(&store, &seeded).expect("failed to stamp delivery");
        let due = list_due_reminders(&store, "2026-08-15T09:00:00Z").expect("failed to sweep");
        assert!(due.is_empty(), "a delivered reminder must not fire again");
    }

    #[test]
    fn mentions_are_rebuilt_from_the_document_while_manual_links_survive() {
        let store = store();
        upsert(&store, &task("task-1", "Problem set 3")).expect("failed to write task");
        upsert(&store, &task("task-2", "Read chapter 4")).expect("failed to write task");
        store
            .with(|connection| {
                connection.execute_batch(
                    "INSERT INTO notes (id, title, doc_json, created_at, updated_at)
                     VALUES ('note-1', 'Lecture 4', '{}', '2026-08-15T08:00:00Z', '2026-08-15T08:00:00Z');",
                )?;
                Ok(())
            })
            .expect("failed to seed note");

        set_manual_note_links(&store, "task-1", &["note-1".to_owned()])
            .expect("failed to set manual link");

        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "taskRef", "attrs": { "taskId": "task-2" } }],
            }],
        });
        store
            .with(|connection| rebuild_mentions_in(connection, "note-1", &doc))
            .expect("failed to rebuild mentions");

        let mut links = list_note_links(&store).expect("failed to list links");
        links.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].origin, "manual");
        assert_eq!(links[1].origin, "mention");

        // The chip is deleted from the paragraph; the manual link must remain.
        let emptied = json!({ "type": "doc", "content": [{ "type": "paragraph" }] });
        store
            .with(|connection| rebuild_mentions_in(connection, "note-1", &emptied))
            .expect("failed to rebuild mentions");
        let links = list_note_links(&store).expect("failed to list links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].task_id, "task-1");
    }
}
