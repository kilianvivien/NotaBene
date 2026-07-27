//! Schema versioning.
//!
//! `user_version` is the ladder. Step 0 → 1 applies `schema.sql`; later steps
//! are added as `ALTER`/backfill blocks. Migrations run inside a transaction,
//! so a failure leaves the database at the version it started on rather than
//! half-migrated.

use super::{DbResult, Store};

/// Must match `SCHEMA_VERSION` in `src/lib/schema/schema.ts`.
pub const SCHEMA_VERSION: i64 = 2;

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
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::SCHEMA_VERSION;

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
}
