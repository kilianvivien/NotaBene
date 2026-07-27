//! Schema versioning.
//!
//! `user_version` is the ladder. Step 0 → 1 applies `schema.sql`; later steps
//! are added as `ALTER`/backfill blocks. Migrations run inside a transaction,
//! so a failure leaves the database at the version it started on rather than
//! half-migrated.

use super::{DbResult, Store};

/// Must match `SCHEMA_VERSION` in `src/lib/schema/schema.ts`.
pub const SCHEMA_VERSION: i64 = 1;

const V1: &str = include_str!("schema.sql");

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
        // Future steps land here, each guarded by `if current < N`.
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    })
}
