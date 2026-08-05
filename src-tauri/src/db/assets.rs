//! Asset metadata and note attachments. Blob bytes live in the app-data
//! directory; SQLite stores only content hashes and metadata.

use rusqlite::{params, Connection};

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
    store.with(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, mime, bytes, width, height, created_at
             FROM assets ORDER BY created_at",
        )?;
        let rows = statement
            .query_map([], asset_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
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
pub fn collect_garbage(store: &Store, referenced_ids: &[String]) -> DbResult<Vec<String>> {
    store.transact(|transaction| {
        let mut statement = transaction.prepare(
            "SELECT id FROM assets
             WHERE id NOT IN (SELECT asset_id FROM attachments)",
        )?;
        let candidates = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let removed: Vec<String> = candidates
            .into_iter()
            .filter(|id| !referenced_ids.contains(id))
            .collect();
        for id in &removed {
            transaction.execute("DELETE FROM assets WHERE id = ?1", [id])?;
        }
        Ok(removed)
    })
}
