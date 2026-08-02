//! Note reads and writes.
//!
//! The query builder below is the hot path of the whole app — it backs the note
//! list, every sidebar view, the search box, and the `search_notes` MCP tool.
//! It composes one SQL statement with bound parameters rather than filtering in
//! Rust, so a 10 000-note library stays an index lookup.

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row};

use super::model::{
    Backlink, Note, NoteMatch, NoteQuery, NoteSummary, Snapshot, SnapshotMeta,
};
use super::{DbError, DbResult, Store};
use crate::commands::SnapshotRetentionPolicy;

fn row_to_summary(row: &Row<'_>) -> rusqlite::Result<NoteSummary> {
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
        snippet: row.get("snippet_text")?,
    })
}

/// How the words of a free-text query combine.
#[derive(Clone, Copy, PartialEq)]
enum TextMatch {
    /// Every word must appear. The note list, the palette and the MCP search
    /// tool all want this: a search box narrows as you type.
    All,
    /// Any word may match, and `bm25` sorts out which note answered best. Only
    /// retrieval wants this — a question is not a filter.
    Any,
}

/// `bm25` column weights in schema order: title, plain_text, tags, course,
/// attachments. Attachments sit *below* body weight on purpose: the column
/// holds a handful of filenames, and bm25's length normalisation already
/// flatters a hit in a short field without any help from us.
const BM25_WEIGHTS: [f64; 5] = [10.0, 1.0, 6.0, 3.0, 0.5];

pub fn query(store: &Store, query: &NoteQuery) -> DbResult<Vec<NoteSummary>> {
    store.with(|connection| {
        let (sql, binds) = build_note_query(query, false);
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(binds.iter()), row_to_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        attach_tags(connection, rows)
    })
}

/// The same query, ranked and scored.
///
/// Retrieval needs three things the note list does not: OR matching, a score it
/// can fuse with other signals, and an order that ignores whether a note is
/// pinned. Rather than a second query builder that would drift from the first
/// on every new filter, both share [`build_note_query`] and differ only in the
/// projection and the ordering.
pub fn search(store: &Store, query: &NoteQuery) -> DbResult<Vec<NoteMatch>> {
    if query
        .text
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        // Nothing to rank by. Silently degrading to a full-table scan ordered by
        // nothing would look like a working search returning bad answers.
        return Err(DbError::Other(
            "SEARCH_REQUIRES_TEXT: a ranked search needs something to rank".into(),
        ));
    }

    store.with(|connection| {
        let (sql, binds) = build_note_query(query, true);
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(binds.iter()), |row| {
                Ok((row_to_summary(row)?, row.get::<_, f64>("score")?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let (summaries, scores): (Vec<NoteSummary>, Vec<f64>) = rows.into_iter().unzip();
        Ok(attach_tags(connection, summaries)?
            .into_iter()
            .zip(scores)
            .map(|(note, score)| NoteMatch { note, score })
            .collect())
    })
}

/// One statement for both entry points, so a filter added for the note list is
/// a filter retrieval gets too.
fn build_note_query(query: &NoteQuery, ranked: bool) -> (String, Vec<SqlValue>) {
    {
        let has_text = query
            .text
            .as_deref()
            .map(str::trim)
            .is_some_and(|text| !text.is_empty());
        let snippet = match (ranked, has_text) {
            // A citation chip wants prose, not `<mark>` — nothing downstream of
            // the ranked path parses highlights, and it wants more of the note.
            (true, _) => "snippet(notes_fts, 1, '', '', ' … ', 64)",
            (false, true) => "snippet(notes_fts, 1, '<mark>', '</mark>', ' … ', 32)",
            (false, false) => "substr(n.plain_text, 1, 200)",
        };
        let score = if ranked {
            // Negated: SQLite's `bm25()` is more-negative-is-better, and every
            // consumer on the TypeScript side expects larger to mean closer.
            let [title, body, tags, course, attachments] = BM25_WEIGHTS;
            format!(
                ", -bm25(notes_fts, {title}, {body}, {tags}, {course}, {attachments}) AS score"
            )
        } else {
            String::new()
        };
        let mut sql = format!(
            "SELECT n.id, n.course_id, n.section_id, n.title, n.pinned, \
             n.archived, n.trashed_at, n.created_at, n.updated_at, n.\"order\", \
             {snippet} AS snippet_text{score} FROM notes n"
        );
        let mut clauses: Vec<String> = Vec::new();
        let mut binds: Vec<SqlValue> = Vec::new();

        // Free text goes through FTS5; everything else is a column predicate.
        if let Some(text) = query.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            let mode = match query.text_match.as_deref() {
                Some("any") => TextMatch::Any,
                _ => TextMatch::All,
            };
            sql.push_str(" JOIN notes_fts ON notes_fts.rowid = n.rowid");
            clauses.push("notes_fts MATCH ?".into());
            binds.push(SqlValue::Text(fts_match_expression(text, mode)));
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

        if ranked {
            // Deliberately *not* `n.pinned DESC` first. Pinning says "keep this
            // where I can see it", not "this answers the question" — floating a
            // barely-matching pinned note above the note that actually answers
            // is how a retrieved context ends up full of the wrong material.
            sql.push_str(" ORDER BY score DESC");
        } else {
            // Pinned notes float, then the requested order. Relevance only means
            // anything when there is an FTS match to rank.
            let order_by = match query.sort.as_deref().unwrap_or("updated") {
                "created" => "n.created_at DESC",
                "title" => "n.title COLLATE NOCASE ASC",
                "manual" => "n.\"order\" ASC, n.updated_at DESC",
                "relevance" if has_text => "notes_fts.rank",
                _ => "n.updated_at DESC",
            };
            sql.push_str(&format!(" ORDER BY n.pinned DESC, {order_by}"));
        }

        sql.push_str(" LIMIT ? OFFSET ?");
        binds.push(SqlValue::Integer(query.limit.unwrap_or(200)));
        binds.push(SqlValue::Integer(query.offset.unwrap_or(0)));

        (sql, binds)
    }
}

/// One extra query for every note's tags, rather than N. At list sizes of a few
/// hundred this is the difference between one round trip and hundreds.
fn attach_tags(connection: &Connection, mut rows: Vec<NoteSummary>) -> DbResult<Vec<NoteSummary>> {
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
/// otherwise turn a search into a parse error. That quoting carries more weight
/// now than it used to: with a real `OR` in the expression, a student who types
/// the word "or" must still be searching for the word, not writing an operator.
fn fts_match_expression(text: &str, mode: TextMatch) -> String {
    let terms = text
        .split_whitespace()
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    match mode {
        TextMatch::All => terms.join(" "),
        // Uppercase because FTS5 only reads `OR` as an operator in caps.
        TextMatch::Any => terms.join(" OR "),
    }
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

        rebuild_links(transaction, note)?;
        // A newly-created note resolves any older `[[Title]]` links that were
        // waiting for it. Existing id-backed links are deliberately untouched.
        transaction.execute(
            "UPDATE note_links SET target_id = ?1
             WHERE target_id IS NULL AND target_title = ?2 COLLATE NOCASE",
            rusqlite::params![note.id, note.title],
        )?;
        reindex_note(transaction, &note.id)?;

        // The note reached disk, so any journalled in-flight copy is stale.
        transaction.execute("DELETE FROM editor_journal WHERE note_id = ?", [&note.id])?;
        Ok(())
    })
}

/// Keep all FTS fields derived from surrounding entities in one row. Course,
/// tag, and attachment writes call this too, so changing metadata is searchable
/// immediately without a full rebuild.
pub(crate) fn reindex_note(connection: &Connection, note_id: &str) -> DbResult<()> {
    let row = connection.query_row(
        "SELECT n.rowid, n.title, n.plain_text,
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
                    FROM attachments a WHERE a.note_id = n.id
                ), '')
         FROM notes n WHERE n.id = ?",
        [note_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        },
    )?;

    connection.execute("DELETE FROM notes_fts WHERE rowid = ?", [row.0])?;
    connection.execute(
        "INSERT INTO notes_fts(rowid, title, plain_text, tags, course, attachments)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![row.0, row.1, row.2, row.3, row.4, row.5],
    )?;
    Ok(())
}

#[derive(Debug)]
struct WikiTarget {
    note_id: Option<String>,
    title: String,
}

fn wiki_targets(doc: &serde_json::Value) -> Vec<WikiTarget> {
    fn walk(node: &serde_json::Value, targets: &mut Vec<WikiTarget>) {
        if node.get("type").and_then(|value| value.as_str()) == Some("wikiLink") {
            if let Some(attrs) = node.get("attrs") {
                let title = attrs
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .trim();
                if !title.is_empty() {
                    targets.push(WikiTarget {
                        note_id: attrs
                            .get("noteId")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned),
                        title: title.to_owned(),
                    });
                }
            }
        }
        if let Some(children) = node.get("content").and_then(|value| value.as_array()) {
            for child in children {
                walk(child, targets);
            }
        }
    }

    let mut targets = Vec::new();
    walk(doc, &mut targets);
    targets
}

fn rebuild_links(connection: &Connection, note: &Note) -> DbResult<()> {
    connection.execute("DELETE FROM note_links WHERE source_id = ?", [&note.id])?;
    for target in wiki_targets(&note.doc) {
        let target_id = match target.note_id {
            Some(id) => Some(id),
            None => connection
                .query_row(
                    "SELECT id FROM notes WHERE title = ? COLLATE NOCASE LIMIT 1",
                    [&target.title],
                    |row| row.get::<_, String>(0),
                )
                .optional()?,
        };
        connection.execute(
            "INSERT OR REPLACE INTO note_links (source_id, target_id, target_title)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![note.id, target_id, target.title],
        )?;
    }
    Ok(())
}

pub fn list_backlinks(store: &Store, note_id: &str) -> DbResult<Vec<Backlink>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT n.id, n.title, substr(n.plain_text, 1, 200), n.updated_at
             FROM note_links l JOIN notes n ON n.id = l.source_id
             WHERE l.target_id = ? AND n.trashed_at IS NULL
             ORDER BY n.updated_at DESC",
        )?;
        let rows = statement
            .query_map([note_id], |row| {
                Ok(Backlink {
                    source_id: row.get(0)?,
                    source_title: row.get(1)?,
                    snippet: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
    store.transact(|transaction| {
        transaction.execute(
            "DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)",
            [note_id],
        )?;
        transaction.execute("DELETE FROM notes WHERE id = ?", [note_id])?;
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

pub fn upsert_snapshot(store: &Store, snapshot: &Snapshot) -> DbResult<()> {
    let doc_json = serde_json::to_string(&snapshot.doc)?;
    store.with(|connection| {
        connection.execute(
            "INSERT INTO snapshots (id, note_id, doc_json, title, cause, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               note_id = excluded.note_id,
               doc_json = excluded.doc_json,
               title = excluded.title,
               cause = excluded.cause,
               created_at = excluded.created_at",
            rusqlite::params![
                snapshot.id,
                snapshot.note_id,
                doc_json,
                snapshot.title,
                snapshot.cause,
                snapshot.created_at
            ],
        )?;
        Ok(())
    })
}

pub fn prune_snapshots(
    store: &Store,
    note_id: &str,
    policy: &SnapshotRetentionPolicy,
) -> DbResult<()> {
    if policy.forever {
        return Ok(());
    }

    store.transact(|transaction| {
        let mut statement = transaction.prepare(
            "SELECT id, created_at FROM snapshots
             WHERE note_id = ? ORDER BY created_at DESC",
        )?;
        let rows = statement
            .query_map([note_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);

        let now = chrono::Utc::now();
        let mut buckets = std::collections::HashSet::new();
        for (id, created_at) in rows {
            let date = chrono::DateTime::parse_from_rfc3339(&created_at)
                .map_err(|error| DbError::Other(format!("invalid snapshot date: {error}")))?
                .with_timezone(&chrono::Utc);
            let age_days = (now - date).num_seconds().max(0) as f64 / 86_400.0;
            if age_days <= policy.keep_all_days {
                continue;
            }
            let bucket = if age_days <= policy.keep_hourly_days {
                date.format("hour:%Y-%m-%dT%H").to_string()
            } else if age_days <= policy.keep_daily_days {
                date.format("day:%Y-%m-%d").to_string()
            } else {
                date.format("week:%G-%V").to_string()
            };
            if !buckets.insert(bucket) {
                transaction.execute("DELETE FROM snapshots WHERE id = ?", [&id])?;
            }
        }
        Ok(())
    })
}

pub fn purge_trash(store: &Store, trashed_before: &str) -> DbResult<usize> {
    store.transact(|transaction| {
        let removed = transaction.execute(
            "DELETE FROM notes WHERE trashed_at IS NOT NULL AND trashed_at <= ?",
            [trashed_before],
        )?;
        Ok(removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{model::Tag, organization};

    /// The same file `src/lib/schema/wireShape.test.ts` parses. One fixture
    /// checked from both ends is the only thing that keeps the Zod schema, the
    /// serde structs, and the SQL columns describing the same note.
    const WIRE_NOTE: &str = include_str!("../../../src/lib/schema/fixtures/wire-note.json");

    /// A real on-disk database rather than `:memory:` — WAL, the FTS5 triggers,
    /// and the foreign keys are part of what is under test.
    struct TempStore {
        store: Store,
        directory: std::path::PathBuf,
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn temp_store() -> TempStore {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before the epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("notabene-test-{unique}"));
        let path = directory.join("notabene.sqlite3");
        let store = Store::open(&path).expect("failed to open the test store");
        TempStore { store, directory }
    }

    #[test]
    fn note_survives_ts_to_sqlite_and_back_unchanged() {
        let expected: serde_json::Value =
            serde_json::from_str(WIRE_NOTE).expect("fixture is not valid JSON");
        let note: Note =
            serde_json::from_value(expected.clone()).expect("fixture does not fit the wire struct");

        let temporary = temp_store();
        let store = &temporary.store;

        // Tags exist before a note references them; the join table has a real
        // foreign key and would reject the write otherwise.
        for tag_id in &note.tag_ids {
            organization::upsert_tag(
                store,
                &Tag {
                    id: tag_id.clone(),
                    namespace: None,
                    name: tag_id.clone(),
                    color: "#9b5c2f".into(),
                },
            )
            .expect("failed to seed a tag");
        }

        upsert(store, &note).expect("failed to write the note");
        let read = get(store, &note.id)
            .expect("failed to read the note back")
            .expect("the note vanished between write and read");

        let actual = serde_json::to_value(&read).expect("failed to serialise the note");
        assert_eq!(
            actual, expected,
            "a note changed shape somewhere between TypeScript, IPC, and SQLite"
        );
    }

    #[test]
    fn round_tripping_a_note_leaves_no_journal_row_behind() {
        let expected: serde_json::Value = serde_json::from_str(WIRE_NOTE).unwrap();
        let mut note: Note = serde_json::from_value(expected).unwrap();
        note.tag_ids.clear();

        let temporary = temp_store();
        let store = &temporary.store;
        upsert(store, &note).expect("failed to write the note");

        crate::db::journal::write(
            store,
            &crate::db::journal::JournalEntry {
                note_id: note.id.clone(),
                doc: note.doc.clone(),
                title: note.title.clone(),
                // Newer than the note: this is exactly the state crash
                // recovery exists to notice.
                written_at: "2099-01-01T00:00:00.000Z".into(),
            },
        )
        .expect("failed to journal");

        assert_eq!(
            crate::db::journal::pending(store).unwrap().len(),
            1,
            "a journal row newer than its note should be offered for recovery"
        );

        // Saving the note is what retires the journal row, in the same
        // transaction, so a save can never leave a phantom recovery behind.
        upsert(store, &note).expect("failed to re-write the note");
        assert!(crate::db::journal::pending(store).unwrap().is_empty());
    }

    fn note_with(id: &str, title: &str, text: &str) -> Note {
        Note {
            id: id.into(),
            course_id: None,
            section_id: None,
            title: title.into(),
            doc: serde_json::json!({
                "type": "doc",
                "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
            }),
            plain_text: text.into(),
            tag_ids: Vec::new(),
            pinned: false,
            archived: false,
            trashed_at: None,
            created_at: "2026-07-27T00:00:00.000Z".into(),
            updated_at: "2026-07-27T00:00:00.000Z".into(),
            order: 0,
        }
    }

    #[test]
    fn fts_is_diacritics_insensitive_and_returns_marked_snippets() {
        let temporary = temp_store();
        let store = &temporary.store;
        upsert(
            store,
            &note_with(
                "fr-note",
                "Révisions",
                "Une notion recherchée accompagne ce résumé.",
            ),
        )
        .unwrap();

        for text in ["recherche", "resume"] {
            let rows = query(
                store,
                &NoteQuery {
                    text: Some(text.into()),
                    sort: Some("relevance".into()),
                    ..NoteQuery::default()
                },
            )
            .unwrap();
            assert_eq!(rows.len(), 1, "{text} should match its accented form");
            assert!(
                rows[0].snippet.contains("<mark>"),
                "search snippets should mark the matched token"
            );
        }
    }

    #[test]
    fn any_matching_joins_terms_with_or_and_still_treats_operators_as_data() {
        assert_eq!(
            fts_match_expression("eigen vector", TextMatch::All),
            "\"eigen\"* \"vector\"*"
        );
        assert_eq!(
            fts_match_expression("eigen vector", TextMatch::Any),
            "\"eigen\"* OR \"vector\"*"
        );
        // A student writing "or" or "NEAR" is searching for a word. Quoting is
        // what keeps the new operators from being reachable from the text box.
        assert_eq!(
            fts_match_expression("OR NEAR", TextMatch::Any),
            "\"OR\"* OR \"NEAR\"*"
        );
        assert_eq!(
            fts_match_expression("say \"this\"", TextMatch::Any),
            "\"say\"* OR \"\"\"this\"\"\"*"
        );
    }

    #[test]
    fn ranked_search_weights_the_title_above_the_body() {
        let temporary = temp_store();
        let store = &temporary.store;
        upsert(store, &note_with("body", "Semaine 3", "eigenvector")).unwrap();
        upsert(store, &note_with("title", "Eigenvector", "notes de cours")).unwrap();

        let rows = search(
            store,
            &NoteQuery {
                text: Some("eigenvector".into()),
                text_match: Some("any".into()),
                ..NoteQuery::default()
            },
        )
        .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].note.id, "title",
            "a title hit should outrank a body hit"
        );
        assert!(
            rows[0].score > rows[1].score,
            "scores should descend, and larger should mean closer"
        );
    }

    #[test]
    fn ranked_search_does_not_float_a_pinned_weak_match() {
        let temporary = temp_store();
        let store = &temporary.store;
        let mut pinned = note_with("pinned", "Divers", "eigenvector mentionné une fois");
        pinned.pinned = true;
        upsert(store, &pinned).unwrap();
        upsert(
            store,
            &note_with("strong", "Eigenvector", "eigenvector eigenvector"),
        )
        .unwrap();

        let rows = search(
            store,
            &NoteQuery {
                text: Some("eigenvector".into()),
                text_match: Some("any".into()),
                ..NoteQuery::default()
            },
        )
        .unwrap();
        assert_eq!(
            rows[0].note.id, "strong",
            "pinning marks a note as handy, not as relevant"
        );

        // …while the note list still floats it, which is the behaviour every
        // existing view depends on.
        let listed = query(
            store,
            &NoteQuery {
                text: Some("eigenvector".into()),
                sort: Some("relevance".into()),
                ..NoteQuery::default()
            },
        )
        .unwrap();
        assert_eq!(listed[0].id, "pinned");
    }

    #[test]
    fn any_matching_finds_what_all_matching_cannot() {
        let temporary = temp_store();
        let store = &temporary.store;
        upsert(
            store,
            &note_with("lecture", "Algèbre", "un vecteur propre ne tourne pas"),
        )
        .unwrap();

        // The words a student remembers, not the words the lecturer used.
        let question = "vecteur direction rotation";
        assert!(
            query(
                store,
                &NoteQuery {
                    text: Some(question.into()),
                    ..NoteQuery::default()
                },
            )
            .unwrap()
            .is_empty(),
            "AND matching is expected to miss this — it is why retrieval needs OR"
        );

        let found = search(
            store,
            &NoteQuery {
                text: Some(question.into()),
                text_match: Some("any".into()),
                ..NoteQuery::default()
            },
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].note.id, "lecture");
        assert!(
            !found[0].note.snippet.contains("<mark>"),
            "a citation snippet is prose, not markup"
        );
    }

    #[test]
    fn all_matching_search_agrees_with_the_note_list() {
        let temporary = temp_store();
        let store = &temporary.store;
        upsert(store, &note_with("a", "Un", "recherche partagée")).unwrap();
        upsert(store, &note_with("b", "Deux", "recherche seule")).unwrap();
        upsert(store, &note_with("c", "Trois", "rien ici")).unwrap();

        let plain = |rows: Vec<NoteSummary>| {
            let mut ids: Vec<String> = rows.into_iter().map(|row| row.id).collect();
            ids.sort();
            ids
        };
        let listed = plain(
            query(
                store,
                &NoteQuery {
                    text: Some("recherche partagée".into()),
                    ..NoteQuery::default()
                },
            )
            .unwrap(),
        );
        let searched = plain(
            search(
                store,
                &NoteQuery {
                    text: Some("recherche partagée".into()),
                    ..NoteQuery::default()
                },
            )
            .unwrap()
            .into_iter()
            .map(|found| found.note)
            .collect(),
        );

        assert_eq!(
            listed, searched,
            "the shared builder must not change what the default path selects"
        );
    }

    #[test]
    fn ranked_search_refuses_a_query_with_nothing_to_rank() {
        let temporary = temp_store();
        assert!(search(
            &temporary.store,
            &NoteQuery {
                text: Some("   ".into()),
                ..NoteQuery::default()
            },
        )
        .is_err());
    }

    #[test]
    fn wiki_backlinks_are_id_backed_across_a_rename() {
        let temporary = temp_store();
        let store = &temporary.store;
        let mut target = note_with("target", "Analyse", "Cours cible");
        upsert(store, &target).unwrap();

        let mut source = note_with("source", "Index", "Voir Analyse");
        source.doc = serde_json::json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "wikiLink",
                    "attrs": { "noteId": "target", "title": "Analyse" }
                }]
            }]
        });
        upsert(store, &source).unwrap();
        assert_eq!(list_backlinks(store, "target").unwrap().len(), 1);

        target.title = "Analyse avancée".into();
        upsert(store, &target).unwrap();
        assert_eq!(
            list_backlinks(store, "target").unwrap().len(),
            1,
            "renaming a target must not break an id-backed wiki link"
        );
    }

    #[test]
    fn phase_d_snapshot_retention_and_trash_purge_are_destructive_only_on_schedule() {
        use chrono::Timelike;

        let temporary = temp_store();
        let store = &temporary.store;
        let mut note = note_with("phase-d", "History", "Current");
        upsert(store, &note).unwrap();

        let two_days_ago = chrono::Utc::now() - chrono::Duration::days(2);
        let same_hour_new = two_days_ago
            .with_minute(50)
            .unwrap()
            .with_second(0)
            .unwrap();
        let same_hour_old = two_days_ago
            .with_minute(10)
            .unwrap()
            .with_second(0)
            .unwrap();
        create_snapshot(
            store,
            "hour-new",
            &note.id,
            "auto",
            &same_hour_new.to_rfc3339(),
        )
        .unwrap();
        create_snapshot(
            store,
            "hour-old",
            &note.id,
            "auto",
            &same_hour_old.to_rfc3339(),
        )
        .unwrap();
        prune_snapshots(
            store,
            &note.id,
            &crate::commands::SnapshotRetentionPolicy {
                keep_all_days: 1.0,
                keep_hourly_days: 7.0,
                keep_daily_days: 90.0,
                forever: false,
            },
        )
        .unwrap();
        let versions = list_snapshots(store, &note.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, "hour-new");

        note.trashed_at = Some("2026-01-01T00:00:00Z".into());
        upsert(store, &note).unwrap();
        assert_eq!(
            purge_trash(store, "2026-02-01T00:00:00Z").unwrap(),
            1
        );
        assert!(get(store, &note.id).unwrap().is_none());
    }

    #[test]
    fn ten_thousand_note_search_stays_under_the_phase_c_budget() {
        let temporary = temp_store();
        let store = &temporary.store;
        store
            .transact(|transaction| {
                for index in 0..10_000_i64 {
                    let id = format!("bench-{index}");
                    let french = index % 2 == 0;
                    let body = if index == 7_777 {
                        "cinétique quantique marqueurunique"
                    } else if french {
                        "cours français recherche résumé équations"
                    } else {
                        "english lecture research summary equations"
                    };
                    transaction.execute(
                        "INSERT INTO notes (
                            id, title, doc_json, plain_text, pinned, archived,
                            created_at, updated_at, \"order\"
                         ) VALUES (?1, ?2, '{\"type\":\"doc\",\"content\":[]}', ?3, 0, 0,
                                   '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z', ?4)",
                        rusqlite::params![id, format!("Note {index}"), body, index],
                    )?;
                    let rowid = transaction.last_insert_rowid();
                    transaction.execute(
                        "INSERT INTO notes_fts(
                            rowid, title, plain_text, tags, course, attachments
                         ) VALUES (?1, ?2, ?3, '', '', '')",
                        rusqlite::params![rowid, format!("Note {index}"), body],
                    )?;
                }
                Ok(())
            })
            .unwrap();

        // Warm SQLite's page cache; search-as-you-type measures steady-state
        // latency, not first-open disk I/O.
        let search = NoteQuery {
            text: Some("marqueurunique".into()),
            sort: Some("relevance".into()),
            limit: Some(20),
            ..NoteQuery::default()
        };
        query(store, &search).unwrap();
        let started = std::time::Instant::now();
        let rows = query(store, &search).unwrap();
        let elapsed = started.elapsed();
        eprintln!("Phase C 10k-note steady-state search: {elapsed:?}");
        assert_eq!(rows.len(), 1);
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "10k-note search took {elapsed:?}, over the 50 ms budget"
        );
    }
}
