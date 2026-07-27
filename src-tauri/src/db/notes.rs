//! Note reads and writes.
//!
//! The query builder below is the hot path of the whole app — it backs the note
//! list, every sidebar view, the search box, and the `search_notes` MCP tool.
//! It composes one SQL statement with bound parameters rather than filtering in
//! Rust, so a 10 000-note library stays an index lookup.

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, Row};

use super::model::{Note, NoteQuery, NoteSummary, Snapshot, SnapshotMeta};
use super::{DbError, DbResult, Store};

const SNIPPET_LEN: usize = 200;

fn row_to_summary(row: &Row<'_>) -> rusqlite::Result<NoteSummary> {
    let plain_text: String = row.get("plain_text")?;
    Ok(NoteSummary {
        id: row.get("id")?,
        course_id: row.get("course_id")?,
        section_id: row.get("section_id")?,
        title: row.get("title")?,
        tag_ids: Vec::new(), // filled in by the caller, one query for all rows
        pinned: row.get::<_, i64>("pinned")? != 0,
        archived: row.get::<_, i64>("archived")? != 0,
        trashed_at: row.get("trashed_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        order: row.get("order")?,
        snippet: plain_text.chars().take(SNIPPET_LEN).collect(),
    })
}

pub fn query(store: &Store, query: &NoteQuery) -> DbResult<Vec<NoteSummary>> {
    store.with(|connection| {
        let mut sql = String::from(
            "SELECT n.id, n.course_id, n.section_id, n.title, n.plain_text, n.pinned, \
             n.archived, n.trashed_at, n.created_at, n.updated_at, n.\"order\" \
             FROM notes n",
        );
        let mut clauses: Vec<String> = Vec::new();
        let mut binds: Vec<SqlValue> = Vec::new();

        // Free text goes through FTS5; everything else is a column predicate.
        if let Some(text) = query.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            sql.push_str(" JOIN notes_fts f ON f.rowid = n.rowid");
            clauses.push("notes_fts MATCH ?".into());
            binds.push(SqlValue::Text(fts_match_expression(text)));
        }

        match query.scope.as_deref().unwrap_or("live") {
            "archived" => {
                clauses.push("n.archived = 1".into());
                clauses.push("n.trashed_at IS NULL".into());
            }
            "trashed" => clauses.push("n.trashed_at IS NOT NULL".into()),
            "all" => {}
            _ => {
                clauses.push("n.archived = 0".into());
                clauses.push("n.trashed_at IS NULL".into());
            }
        }

        if let Some(course_id) = &query.course_id {
            match course_id {
                Some(id) => {
                    clauses.push("n.course_id = ?".into());
                    binds.push(SqlValue::Text(id.clone()));
                }
                // Explicit null: the inbox.
                None => clauses.push("n.course_id IS NULL".into()),
            }
        }

        if let Some(Some(section_id)) = &query.section_id {
            clauses.push("n.section_id = ?".into());
            binds.push(SqlValue::Text(section_id.clone()));
        }

        if let Some(pinned) = query.pinned {
            clauses.push("n.pinned = ?".into());
            binds.push(SqlValue::Integer(i64::from(pinned)));
        }

        if let Some(after) = &query.created_after {
            clauses.push("n.created_at >= ?".into());
            binds.push(SqlValue::Text(after.clone()));
        }

        if let Some(before) = &query.created_before {
            clauses.push("n.created_at <= ?".into());
            binds.push(SqlValue::Text(before.clone()));
        }

        for feature in query.has.iter().flatten() {
            match feature.as_str() {
                "image" => clauses.push("n.has_image = 1".into()),
                "drawing" => clauses.push("n.has_drawing = 1".into()),
                "table" => clauses.push("n.has_table = 1".into()),
                "attachment" => clauses.push(
                    "EXISTS (SELECT 1 FROM attachments a WHERE a.note_id = n.id)".into(),
                ),
                _ => {}
            }
        }

        // Every requested tag must be present, not just one of them — a
        // student filtering by two tags means the intersection.
        if let Some(tag_ids) = query.tag_ids.as_ref().filter(|ids| !ids.is_empty()) {
            let placeholders = vec!["?"; tag_ids.len()].join(", ");
            clauses.push(format!(
                "(SELECT COUNT(*) FROM note_tags t WHERE t.note_id = n.id AND t.tag_id IN ({placeholders})) = {}",
                tag_ids.len()
            ));
            for id in tag_ids {
                binds.push(SqlValue::Text(id.clone()));
            }
        }

        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }

        // Pinned notes float, then the requested order. Relevance only means
        // anything when there is an FTS match to rank.
        let has_text = query.text.as_deref().map(str::trim).is_some_and(|t| !t.is_empty());
        let order_by = match query.sort.as_deref().unwrap_or("updated") {
            "created" => "n.created_at DESC",
            "title" => "n.title COLLATE NOCASE ASC",
            "manual" => "n.\"order\" ASC, n.updated_at DESC",
            "relevance" if has_text => "f.rank",
            _ => "n.updated_at DESC",
        };
        sql.push_str(&format!(" ORDER BY n.pinned DESC, {order_by}"));

        sql.push_str(" LIMIT ? OFFSET ?");
        binds.push(SqlValue::Integer(query.limit.unwrap_or(200)));
        binds.push(SqlValue::Integer(query.offset.unwrap_or(0)));

        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(binds.iter()), row_to_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        attach_tags(connection, rows)
    })
}

/// One extra query for every note's tags, rather than N. At list sizes of a few
/// hundred this is the difference between one round trip and hundreds.
fn attach_tags(
    connection: &Connection,
    mut rows: Vec<NoteSummary>,
) -> DbResult<Vec<NoteSummary>> {
    if rows.is_empty() {
        return Ok(rows);
    }

    let placeholders = vec!["?"; rows.len()].join(", ");
    let mut statement = connection.prepare(&format!(
        "SELECT note_id, tag_id FROM note_tags WHERE note_id IN ({placeholders})"
    ))?;
    let ids: Vec<SqlValue> = rows
        .iter()
        .map(|row| SqlValue::Text(row.id.clone()))
        .collect();

    let pairs = statement
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for (note_id, tag_id) in pairs {
        if let Some(row) = rows.iter_mut().find(|row| row.id == note_id) {
            row.tag_ids.push(tag_id);
        }
    }
    Ok(rows)
}

/// Turn a user's words into an FTS5 prefix query.
///
/// Every token is quoted before the `*` is appended, so a stray `"` or `-` in a
/// lecture title is data rather than syntax — an unquoted apostrophe would
/// otherwise turn a search into a parse error.
fn fts_match_expression(text: &str) -> String {
    text.split_whitespace()
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn get(store: &Store, note_id: &str) -> DbResult<Option<Note>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, course_id, section_id, title, doc_json, plain_text, pinned, archived, \
             trashed_at, created_at, updated_at, \"order\" FROM notes WHERE id = ?",
        )?;

        let mut rows = statement.query([note_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };

        let doc_json: String = row.get("doc_json")?;
        let mut note = Note {
            id: row.get("id")?,
            course_id: row.get("course_id")?,
            section_id: row.get("section_id")?,
            title: row.get("title")?,
            doc: serde_json::from_str(&doc_json)?,
            plain_text: row.get("plain_text")?,
            tag_ids: Vec::new(),
            pinned: row.get::<_, i64>("pinned")? != 0,
            archived: row.get::<_, i64>("archived")? != 0,
            trashed_at: row.get("trashed_at")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            order: row.get("order")?,
        };

        let mut tag_statement =
            connection.prepare("SELECT tag_id FROM note_tags WHERE note_id = ?")?;
        note.tag_ids = tag_statement
            .query_map([note_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(Some(note))
    })
}

pub fn upsert(store: &Store, note: &Note) -> DbResult<()> {
    let doc_json = serde_json::to_string(&note.doc)?;
    let (has_image, has_drawing, has_table) = doc_features(&note.doc);

    store.transact(|transaction| {
        transaction.execute(
            "INSERT INTO notes (id, course_id, section_id, title, doc_json, plain_text, \
             pinned, archived, trashed_at, created_at, updated_at, \"order\", \
             has_image, has_drawing, has_table) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
             ON CONFLICT(id) DO UPDATE SET \
             course_id = excluded.course_id, section_id = excluded.section_id, \
             title = excluded.title, doc_json = excluded.doc_json, \
             plain_text = excluded.plain_text, pinned = excluded.pinned, \
             archived = excluded.archived, trashed_at = excluded.trashed_at, \
             updated_at = excluded.updated_at, \"order\" = excluded.\"order\", \
             has_image = excluded.has_image, has_drawing = excluded.has_drawing, \
             has_table = excluded.has_table",
            rusqlite::params![
                note.id,
                note.course_id,
                note.section_id,
                note.title,
                doc_json,
                note.plain_text,
                i64::from(note.pinned),
                i64::from(note.archived),
                note.trashed_at,
                note.created_at,
                note.updated_at,
                note.order,
                i64::from(has_image),
                i64::from(has_drawing),
                i64::from(has_table),
            ],
        )?;

        // Replace rather than diff: the set is tiny and this cannot drift.
        transaction.execute("DELETE FROM note_tags WHERE note_id = ?", [&note.id])?;
        for tag_id in &note.tag_ids {
            transaction.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
                rusqlite::params![note.id, tag_id],
            )?;
        }

        // The note reached disk, so any journalled in-flight copy is stale.
        transaction.execute("DELETE FROM editor_journal WHERE note_id = ?", [&note.id])?;
        Ok(())
    })
}

/// Walk the document once for the denormalised `has_*` flags.
fn doc_features(doc: &serde_json::Value) -> (bool, bool, bool) {
    fn walk(node: &serde_json::Value, flags: &mut (bool, bool, bool)) {
        if let Some(kind) = node.get("type").and_then(|value| value.as_str()) {
            match kind {
                "image" => flags.0 = true,
                "drawing" | "excalidraw" => flags.1 = true,
                "table" => flags.2 = true,
                _ => {}
            }
        }
        if let Some(children) = node.get("content").and_then(|value| value.as_array()) {
            for child in children {
                walk(child, flags);
            }
        }
    }

    let mut flags = (false, false, false);
    walk(doc, &mut flags);
    flags
}

pub fn set_trashed(store: &Store, note_id: &str, trashed_at: Option<&str>) -> DbResult<()> {
    store.with(|connection| {
        connection.execute(
            "UPDATE notes SET trashed_at = ?1 WHERE id = ?2",
            rusqlite::params![trashed_at, note_id],
        )?;
        Ok(())
    })
}

pub fn purge(store: &Store, note_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM notes WHERE id = ?", [note_id])?;
        Ok(())
    })
}

pub fn list_snapshots(store: &Store, note_id: &str) -> DbResult<Vec<SnapshotMeta>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, note_id, title, cause, created_at FROM snapshots \
             WHERE note_id = ? ORDER BY created_at DESC",
        )?;
        let rows = statement
            .query_map([note_id], |row| {
                Ok(SnapshotMeta {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    title: row.get(2)?,
                    cause: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get_snapshot(store: &Store, snapshot_id: &str) -> DbResult<Option<Snapshot>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, note_id, doc_json, title, cause, created_at FROM snapshots WHERE id = ?",
        )?;
        let mut rows = statement.query([snapshot_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let doc_json: String = row.get(2)?;
        Ok(Some(Snapshot {
            id: row.get(0)?,
            note_id: row.get(1)?,
            doc: serde_json::from_str(&doc_json)?,
            title: row.get(3)?,
            cause: row.get(4)?,
            created_at: row.get(5)?,
        }))
    })
}

pub fn create_snapshot(
    store: &Store,
    id: &str,
    note_id: &str,
    cause: &str,
    created_at: &str,
) -> DbResult<Snapshot> {
    let note = get(store, note_id)?
        .ok_or_else(|| DbError::Other(format!("cannot snapshot unknown note {note_id}")))?;
    let doc_json = serde_json::to_string(&note.doc)?;

    store.with(|connection| {
        connection.execute(
            "INSERT INTO snapshots (id, note_id, doc_json, title, cause, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, note_id, doc_json, note.title, cause, created_at],
        )?;
        Ok(())
    })?;

    Ok(Snapshot {
        id: id.to_string(),
        note_id: note_id.to_string(),
        doc: note.doc,
        title: note.title,
        cause: cause.to_string(),
        created_at: created_at.to_string(),
    })
}
