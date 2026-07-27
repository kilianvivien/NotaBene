//! Wire types shared with the TypeScript layer.
//!
//! `camelCase` on the wire, `snake_case` in Rust, `snake_case` in SQL. These
//! structs are the Rust half of `src/lib/schema/schema.ts` — when one changes,
//! the other has to.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub professor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semester: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    pub order: i64,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub course_id: String,
    pub name: String,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub course_id: Option<String>,
    pub section_id: Option<String>,
    pub title: String,
    pub doc: Value,
    pub plain_text: String,
    pub tag_ids: Vec<String>,
    pub pinned: bool,
    pub archived: bool,
    pub trashed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub order: i64,
}

/// What the note list renders — everything but the document itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub course_id: Option<String>,
    pub section_id: Option<String>,
    pub title: String,
    pub tag_ids: Vec<String>,
    pub pinned: bool,
    pub archived: bool,
    pub trashed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub order: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub note_id: String,
    pub doc: Value,
    pub title: String,
    pub cause: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub cause: String,
    pub created_at: String,
}

/// Mirrors `NoteQuery` in `LibraryAdapter.ts`. Every field is optional, and
/// `None` means "no constraint" rather than "match null" — except `course_id`,
/// where the inbox genuinely needs to ask for notes with no course. That is
/// why it is a double option.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteQuery {
    pub text: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub course_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub section_id: Option<Option<String>>,
    pub tag_ids: Option<Vec<String>>,
    pub has: Option<Vec<String>>,
    pub created_after: Option<String>,
    pub created_before: Option<String>,
    pub pinned: Option<bool>,
    pub scope: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Distinguish an absent key from an explicit `null`.
fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}
