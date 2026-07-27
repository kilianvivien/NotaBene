//! The note store: SQLite, owned entirely by the Rust side.
//!
//! One connection, behind a mutex. That is not a performance compromise — a
//! single-user desktop app never has enough concurrency for a pool to pay for
//! itself, and serialising writes is exactly what makes "never lose a
//! keystroke" easy to reason about.

pub mod assets;
pub mod journal;
pub mod migrations;
pub mod model;
pub mod notes;
pub mod organization;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

/// Tauri commands must return something serialisable; a plain string is what
/// the TypeScript adapter surfaces to the user.
impl serde::Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type DbResult<T> = Result<T, DbError>;

pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &PathBuf) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| DbError::Other(err.to_string()))?;
        }
        let connection = Connection::open(path)?;

        // WAL is what makes a hard kill survivable: committed transactions are
        // in the log before the app is told the write succeeded. NORMAL sync
        // is the right trade here — a power cut can cost the last transaction,
        // and the editor journal covers that gap.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        // Let a blocked write wait rather than fail; nothing here holds a lock
        // for long.
        connection.busy_timeout(std::time::Duration::from_secs(5))?;

        let store = Self {
            connection: Mutex::new(connection),
        };
        migrations::run(&store)?;
        Ok(store)
    }

    /// Run `body` with the connection held. Panics only if a previous holder
    /// panicked mid-transaction, which is not a state worth continuing from.
    pub fn with<T>(&self, body: impl FnOnce(&Connection) -> DbResult<T>) -> DbResult<T> {
        let guard = self.connection.lock().expect("store mutex poisoned");
        body(&guard)
    }

    /// Run `body` inside a transaction, rolling back on error.
    pub fn transact<T>(
        &self,
        body: impl FnOnce(&rusqlite::Transaction<'_>) -> DbResult<T>,
    ) -> DbResult<T> {
        let mut guard = self.connection.lock().expect("store mutex poisoned");
        let transaction = guard.transaction()?;
        let value = body(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }
}

/// Where the library lives: `~/Library/Application Support/app.notabene.desktop/`.
pub fn database_path(app: &AppHandle) -> DbResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| DbError::Other(err.to_string()))?;
    Ok(dir.join("notabene.sqlite3"))
}

pub fn assets_path(app: &AppHandle) -> DbResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| DbError::Other(err.to_string()))?;
    Ok(dir.join("assets"))
}
