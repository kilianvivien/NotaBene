//! Asset metadata and note attachments. Blob bytes live in the app-data
//! directory; SQLite stores only content hashes and metadata.

use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde_json::Value;

use super::model::{Asset, Attachment};
use super::{notes, DbResult, Store};

fn asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: row.get(0)?,
        mime: row.get(1)?,
        bytes: row.get(2)?,
        width: row.get(3)?,
        height: row.get(4)?,
        created_at: row.get(5)?,
    })
}

pub fn upsert_asset(store: &Store, asset: &Asset) -> DbResult<()> {
    store.with(|connection| upsert_asset_in(connection, asset))
}

pub(crate) fn upsert_asset_in(connection: &Connection, asset: &Asset) -> DbResult<()> {
    connection.execute(
        "INSERT INTO assets (id, mime, bytes, width, height, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           mime = excluded.mime,
           bytes = excluded.bytes,
           width = COALESCE(excluded.width, assets.width),
           height = COALESCE(excluded.height, assets.height)",
        params![
            asset.id,
            asset.mime,
            asset.bytes,
            asset.width,
            asset.height,
            asset.created_at
        ],
    )?;
    Ok(())
}

pub fn stat(store: &Store, asset_id: &str) -> DbResult<Option<Asset>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, mime, bytes, width, height, created_at
             FROM assets WHERE id = ?1",
        )?;
        let mut rows = statement.query([asset_id])?;
        Ok(rows.next()?.map(asset_from_row).transpose()?)
    })
}

pub fn list_assets(store: &Store) -> DbResult<Vec<Asset>> {
    store.with(list_assets_in)
}

pub(crate) fn list_assets_in(connection: &Connection) -> DbResult<Vec<Asset>> {
    let mut statement = connection.prepare(
        "SELECT id, mime, bytes, width, height, created_at
             FROM assets ORDER BY created_at",
    )?;
    let rows = statement
        .query_map([], asset_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub(crate) fn list_all_attachments_in(connection: &Connection) -> DbResult<Vec<Attachment>> {
    let mut statement = connection.prepare(
        "SELECT id, note_id, asset_id, name, created_at
         FROM attachments ORDER BY created_at",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                note_id: row.get(1)?,
                asset_id: row.get(2)?,
                name: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_attachments(store: &Store, note_id: &str) -> DbResult<Vec<Attachment>> {
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, note_id, asset_id, name, created_at
             FROM attachments WHERE note_id = ?1 ORDER BY created_at",
        )?;
        let rows = statement
            .query_map([note_id], |row| {
                Ok(Attachment {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    asset_id: row.get(2)?,
                    name: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn upsert_attachment(store: &Store, attachment: &Attachment) -> DbResult<()> {
    store.transact(|transaction| upsert_attachment_in(transaction, attachment))
}

pub(crate) fn upsert_attachment_in(
    connection: &Connection,
    attachment: &Attachment,
) -> DbResult<()> {
    let previous_note_id = connection
        .query_row(
            "SELECT note_id FROM attachments WHERE id = ?",
            [&attachment.id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    connection.execute(
        "INSERT INTO attachments (id, note_id, asset_id, name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           note_id = excluded.note_id,
           asset_id = excluded.asset_id,
           name = excluded.name",
        params![
            attachment.id,
            attachment.note_id,
            attachment.asset_id,
            attachment.name,
            attachment.created_at
        ],
    )?;
    notes::reindex_note(connection, &attachment.note_id)?;
    if let Some(previous) = previous_note_id.filter(|id| id != &attachment.note_id) {
        notes::reindex_note(connection, &previous)?;
    }
    Ok(())
}

pub fn delete_attachment(store: &Store, attachment_id: &str) -> DbResult<()> {
    store.transact(|connection| {
        let note_id = connection
            .query_row(
                "SELECT note_id FROM attachments WHERE id = ?1",
                [attachment_id],
                |row| row.get::<_, String>(0),
            )
            .ok();
        connection.execute("DELETE FROM attachments WHERE id = ?1", [attachment_id])?;
        if let Some(note_id) = note_id {
            notes::reindex_note(connection, &note_id)?;
        }
        Ok(())
    })
}

/// Remove unreferenced metadata and return the ids whose files can be removed.
/// Attachments are always references even if the caller only supplied ids from
/// document nodes.
fn collect_asset_ids(value: &Value, referenced: &mut HashSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(id)) = object.get("assetId") {
                referenced.insert(id.clone());
            }
            for child in object.values() {
                collect_asset_ids(child, referenced);
            }
        }
        Value::Array(array) => {
            for child in array {
                collect_asset_ids(child, referenced);
            }
        }
        _ => {}
    }
}

pub fn collect_garbage(store: &Store) -> DbResult<Vec<(String, i64)>> {
    store.transact(|transaction| {
        let mut referenced = HashSet::new();
        let mut documents = transaction.prepare(
            "SELECT doc_json FROM notes
             UNION ALL SELECT doc_json FROM snapshots
             UNION ALL SELECT doc_json FROM templates
             UNION ALL SELECT doc_json FROM editor_journal",
        )?;
        let rows = documents.query_map([], |row| row.get::<_, String>(0))?;
        for raw in rows {
            let document: Value = serde_json::from_str(&raw?)?;
            collect_asset_ids(&document, &mut referenced);
        }

        let mut statement = transaction.prepare(
            "SELECT id, bytes FROM assets
             WHERE id NOT IN (SELECT asset_id FROM attachments)",
        )?;
        let candidates = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let removed: Vec<(String, i64)> = candidates
            .into_iter()
            .filter(|(id, _)| !referenced.contains(id))
            .collect();
        for (id, _) in &removed {
            transaction.execute("DELETE FROM assets WHERE id = ?1", [id])?;
        }
        Ok(removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            .expect("clock before epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("notabene-assets-{unique}"));
        let store = Store::open(
            &directory.join("notabene.sqlite3"),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .expect("open store");
        TempStore { store, directory }
    }

    #[test]
    fn garbage_collection_preserves_every_durable_document_reference() {
        let temporary = temp_store();
        let store = &temporary.store;
        store
            .transact(|connection| {
                for id in ["live", "snapshot", "template", "journal", "orphan"] {
                    connection.execute(
                        "INSERT INTO assets (id, mime, bytes, created_at)
                         VALUES (?1, 'image/png', 10, '2026-01-01T00:00:00Z')",
                        [id],
                    )?;
                }
                connection.execute(
                    "INSERT INTO notes
                     (id, doc_json, plain_text, created_at, updated_at)
                     VALUES ('note', ?1, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                    [r#"{"type":"doc","content":[{"attrs":{"assetId":"live"}}]}"#],
                )?;
                connection.execute(
                    "INSERT INTO snapshots (id, note_id, doc_json, cause, created_at)
                     VALUES ('snap', 'note', ?1, 'auto', '2026-01-01T00:00:00Z')",
                    [r#"{"attrs":{"assetId":"snapshot"}}"#],
                )?;
                connection.execute(
                    "INSERT INTO templates (id, name, doc_json) VALUES ('tpl', 'Template', ?1)",
                    [r#"{"attrs":{"assetId":"template"}}"#],
                )?;
                connection.execute(
                    "INSERT INTO editor_journal (note_id, doc_json, title, written_at)
                     VALUES ('note', ?1, '', '2026-01-01T00:00:01Z')",
                    [r#"{"attrs":{"assetId":"journal"}}"#],
                )?;
                Ok(())
            })
            .expect("seed store");

        let removed = collect_garbage(store).expect("collect garbage");

        assert_eq!(removed, vec![("orphan".into(), 10)]);
        assert_eq!(list_assets(store).expect("list assets").len(), 4);
    }
}
