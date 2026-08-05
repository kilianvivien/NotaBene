//! Smart folders and note templates.

use rusqlite::Connection;

use super::model::{NoteTemplate, SavedSearch};
use super::{DbResult, Store};

pub fn list_saved_searches(store: &Store) -> DbResult<Vec<SavedSearch>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, name, query, created_at FROM saved_searches ORDER BY name COLLATE NOCASE",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(SavedSearch {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    query: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn upsert_saved_search(store: &Store, search: &SavedSearch) -> DbResult<()> {
    store.with(|connection| upsert_saved_search_in(connection, search))
}

pub(crate) fn upsert_saved_search_in(
    connection: &Connection,
    search: &SavedSearch,
) -> DbResult<()> {
    connection.execute(
        "INSERT INTO saved_searches (id, name, query, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query",
        rusqlite::params![search.id, search.name, search.query, search.created_at],
    )?;
    Ok(())
}

pub fn delete_saved_search(store: &Store, search_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM saved_searches WHERE id = ?", [search_id])?;
        Ok(())
    })
}

pub fn list_templates(store: &Store) -> DbResult<Vec<NoteTemplate>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, name, course_id, title_pattern, doc_json
             FROM templates ORDER BY name COLLATE NOCASE",
        )?;
        let mut templates = statement
            .query_map([], |row| {
                let doc_json: String = row.get(4)?;
                Ok(NoteTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    course_id: row.get(2)?,
                    title_pattern: row.get(3)?,
                    doc: serde_json::from_str(&doc_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    tag_ids: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut tags = connection
            .prepare("SELECT tag_id FROM template_tags WHERE template_id = ? ORDER BY tag_id")?;
        for template in &mut templates {
            template.tag_ids = tags
                .query_map([&template.id], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
        }
        Ok(templates)
    })
}

pub fn upsert_template(store: &Store, template: &NoteTemplate) -> DbResult<()> {
    store.transact(|transaction| upsert_template_in(transaction, template))
}

pub(crate) fn upsert_template_in(connection: &Connection, template: &NoteTemplate) -> DbResult<()> {
    let doc_json = serde_json::to_string(&template.doc)?;
    connection.execute(
        "INSERT INTO templates (id, name, course_id, title_pattern, doc_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
           course_id = excluded.course_id,
           title_pattern = excluded.title_pattern,
           doc_json = excluded.doc_json",
        rusqlite::params![
            template.id,
            template.name,
            template.course_id,
            template.title_pattern,
            doc_json
        ],
    )?;
    connection.execute(
        "DELETE FROM template_tags WHERE template_id = ?",
        [&template.id],
    )?;
    for tag_id in &template.tag_ids {
        connection.execute(
            "INSERT OR IGNORE INTO template_tags (template_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![template.id, tag_id],
        )?;
    }
    Ok(())
}

pub fn delete_template(store: &Store, template_id: &str) -> DbResult<()> {
    store.with(|connection| {
        connection.execute("DELETE FROM templates WHERE id = ?", [template_id])?;
        Ok(())
    })
}
