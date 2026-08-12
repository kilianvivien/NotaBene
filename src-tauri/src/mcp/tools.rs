//! The MCP tool surface exposed to local coding agents.
//!
//! Every handler is a thin forward into the webview executor (see `bridge.rs`);
//! nothing here touches the database directly. That is deliberate — it is what
//! guarantees an agent write is validated, versioned, and autosaved exactly
//! like a keystroke.
//!
//! Note what is missing: there is no permanent-delete or empty-Trash tool.
//! Agents may use recoverable Trash, but no amount of model confusion can purge
//! a student's notes (PRD §5.7).

use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, InitializeResult, ServerCapabilities};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde_json::{json, Value};

use super::bridge::{BridgeCallError, ClientInfo, McpBridge};

/// Reads are answered from live app state.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Writes may wait on an autosave flush or a busy editor.
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesParams {
    /// Restrict to one course; omit for the whole library.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_id: Option<String>,
    /// `live`, `archived`, or `trashed`. Defaults to `live`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Page size, 1–500. Defaults to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchNotesParams {
    /// Same syntax as the in-app search box: free text plus `course:`, `tag:`,
    /// `prof:`, `semester:`, `type:`, `has:image|drawing|table|attachment`,
    /// `before:`/`after:`/`on:` (YYYY-MM-DD), and `is:pinned`.
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadNoteParams {
    pub note_id: String,
    /// `json` for the document tree, `markdown` for rendered text, `both` for
    /// each. Defaults to `both`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    /// Note body as Markdown; converted to the editor's document model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    /// Lossless structured editor document. Do not supply with `markdown`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<Value>,
    /// Tags as `name` or `namespace:name`, e.g. `topic:derivatives`.
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteParams {
    pub note_id: String,
    /// `updatedAt` returned by read/list/search. The update is rejected if the
    /// user changed the note in the meantime.
    pub base_updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Replacement body as Markdown. The previous content is kept as a version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    /// Archive without putting the note in Trash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionedNoteParams {
    pub note_id: String,
    /// `updatedAt` returned by read/list/search.
    pub base_updated_at: String,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionedNotesParams {
    /// Notes to move, each with its concurrency token. Maximum 500.
    pub notes: Vec<VersionedNoteParams>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MergeNotesParams {
    /// Notes in the exact order they should appear in the merged document.
    pub notes: Vec<VersionedNoteParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `keep`, `archive`, or recoverable `trash`. Defaults to `keep`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fate: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManageTagsParams {
    pub note_id: String,
    /// `updatedAt` returned by read/list/search.
    pub base_updated_at: String,
    /// Tags to add, as `name` or `namespace:name`. Created if new.
    #[serde(default)]
    pub add: Vec<String>,
    /// Tag ids to remove.
    #[serde(default)]
    pub remove: Vec<String>,
    /// Rename global tags while managing this note.
    #[serde(default)]
    pub rename: Vec<RenameTagParams>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameTagParams {
    pub tag_id: String,
    pub name: String,
    /// Namespace string, or null for a plain tag.
    pub namespace: Value,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateCourseParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub professor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semester: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportNotesParams {
    pub note_ids: Vec<String>,
    /// `markdown`, `html`, `pdf`, or `docx`.
    pub format: String,
    /// File name written inside Downloads/NotaBene exports. Path separators
    /// are refused by the app bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// Deprecated: retained for one release so old clients receive a clear
    /// migration error instead of writing to an unexpected location.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_toc: Option<bool>,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSectionParams {
    pub course_id: String,
    pub name: String,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveNoteParams {
    pub note_id: String,
    pub base_updated_at: String,
    /// Course id, or null for Inbox.
    pub course_id: Value,
    /// Section id, or null for the course root / Inbox.
    pub section_id: Value,
}

#[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_section: Option<CreateSectionParams>,
    #[serde(default)]
    pub moves: Vec<MoveNoteParams>,
}

#[derive(Clone)]
pub struct NotaBeneMcpServer {
    bridge: Arc<McpBridge>,
    can_write: bool,
}

fn client_of(ctx: &RequestContext<RoleServer>) -> Option<ClientInfo> {
    ctx.peer.peer_info().map(|info| ClientInfo {
        name: info.client_info.name.clone(),
        version: Some(info.client_info.version.clone()),
    })
}

fn timeout_error() -> Value {
    json!({
        "code": "APP_NOT_READY",
        "message": "NotaBene did not answer in time. Make sure the app window is open.",
        "recoverable": true
    })
}

/// Bridge outcome → client-visible tool result.
fn to_tool_result(outcome: Result<Value, BridgeCallError>) -> Result<CallToolResult, ErrorData> {
    match outcome {
        Ok(value) => Ok(CallToolResult::success(vec![ContentBlock::text(
            value.to_string(),
        )])),
        Err(BridgeCallError::Tool(payload)) => Ok(CallToolResult::error(vec![ContentBlock::text(
            json!({ "error": payload }).to_string(),
        )])),
        Err(BridgeCallError::Timeout) => Ok(CallToolResult::error(vec![ContentBlock::text(
            json!({ "error": timeout_error() }).to_string(),
        )])),
        Err(BridgeCallError::Emit(message)) => Err(ErrorData::internal_error(
            format!("NotaBene bridge failure: {message}"),
            None,
        )),
    }
}

fn to_args<T: serde::Serialize>(params: &T) -> Result<Value, ErrorData> {
    serde_json::to_value(params)
        .map_err(|err| ErrorData::internal_error(format!("argument encoding failed: {err}"), None))
}

#[tool_router]
impl NotaBeneMcpServer {
    pub fn new(bridge: Arc<McpBridge>, can_write: bool) -> Self {
        Self { bridge, can_write }
    }

    fn refuse_write(&self) -> Option<Result<CallToolResult, ErrorData>> {
        (!self.can_write).then(|| {
            Ok(CallToolResult::error(vec![ContentBlock::text(
                json!({
                    "error": {
                        "code": "PAIRING_READ_ONLY",
                        "message": "This NotaBene pairing is read-only. Enable write access in Settings → Connections to use this tool.",
                        "recoverable": false
                    }
                })
                .to_string(),
            )]))
        })
    }

    #[tool(
        name = "notabene_get_app_state",
        description = "Live NotaBene state: the note currently open, the active view, the current selection, and the app version. Call this first so you can act on what the user is looking at."
    )]
    pub async fn get_app_state(
        &self,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        to_tool_result(
            self.bridge
                .call("get_app_state", Value::Null, client_of(&ctx), READ_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_list_courses",
        description = "List the student's courses with colour, professor, and semester. Course ids from here are what the other tools take."
    )]
    pub async fn list_courses(
        &self,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        to_tool_result(
            self.bridge
                .call("list_courses", Value::Null, client_of(&ctx), READ_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_list_tags",
        description = "List the library's existing tags with ids, names, namespaces, and colours. Use this before organizing or composing tag-filtered searches so you reuse the student's taxonomy."
    )]
    pub async fn list_tags(
        &self,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        to_tool_result(
            self.bridge
                .call("list_tags", Value::Null, client_of(&ctx), READ_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_list_notes",
        description = "Browse live, archived, or trashed notes, newest first, optionally within one course. Returns summaries with a text snippet and revision token — call notabene_read_note for the full document."
    )]
    pub async fn list_notes(
        &self,
        Parameters(params): Parameters<ListNotesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("list_notes", args, client_of(&ctx), READ_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_search_notes",
        description = "Full-text search across the library using the same query syntax as the in-app search box. Diacritics-insensitive, so \"resume\" finds \"résumé\"."
    )]
    pub async fn search_notes(
        &self,
        Parameters(params): Parameters<SearchNotesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("search_notes", args, client_of(&ctx), READ_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_read_note",
        description = "Read one note as structured JSON, rendered Markdown, or both, along with its course and tags."
    )]
    pub async fn read_note(
        &self,
        Parameters(params): Parameters<ReadNoteParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("read_note", args, client_of(&ctx), READ_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_create_note",
        description = "Create a note from Markdown and file it under a course. Autosave and version history apply exactly as they would to a note the student typed."
    )]
    pub async fn create_note(
        &self,
        Parameters(params): Parameters<CreateNoteParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("create_note", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_update_note",
        description = "Update a note's title, body, course, section, or archived flag. Pass the note's current updatedAt as baseUpdatedAt; a concurrent user edit returns a recoverable conflict. The previous state is kept as a restorable agent version."
    )]
    pub async fn update_note(
        &self,
        Parameters(params): Parameters<UpdateNoteParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("update_note", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_merge_notes",
        description = "Merge two or more notes into one in the exact supplied order. Source notes may be kept, archived, or moved to recoverable Trash. Every source needs its current updatedAt; permanent deletion is unavailable."
    )]
    pub async fn merge_notes(
        &self,
        Parameters(params): Parameters<MergeNotesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("merge_notes", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_trash_notes",
        description = "Move one or more notes to recoverable Trash after checking each current updatedAt. This never permanently deletes anything; emptying or purging Trash is not exposed."
    )]
    pub async fn trash_notes(
        &self,
        Parameters(params): Parameters<VersionedNotesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("trash_notes", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_restore_notes",
        description = "Restore one or more notes from Trash after checking each current updatedAt. Browse with notabene_list_notes scope=trashed first."
    )]
    pub async fn restore_notes(
        &self,
        Parameters(params): Parameters<VersionedNotesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("restore_notes", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_manage_tags",
        description = "Add, remove, or rename tags on a note. Pass the note's current updatedAt as baseUpdatedAt. Tags may be plain (`revision`) or namespaced (`topic:derivatives`, `type:summary`); namespaced tags power the faceted search filters."
    )]
    pub async fn manage_tags(
        &self,
        Parameters(params): Parameters<ManageTagsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("manage_tags", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_create_course",
        description = "Create a course to file notes under. Colour and icon are assigned automatically."
    )]
    pub async fn create_course(
        &self,
        Parameters(params): Parameters<CreateCourseParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("create_course", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_export_notes",
        description = "Export selected notes into Downloads/NotaBene exports as Markdown, HTML, PDF, or DOCX. Pass a fileName, never a path. Separate multi-note exports are packaged as a zip."
    )]
    pub async fn export_notes(
        &self,
        Parameters(params): Parameters<ExportNotesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("export_notes", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }

    #[tool(
        name = "notabene_organize",
        description = "Create a course section and/or move notes into courses and sections. Every move requires the note's current updatedAt as baseUpdatedAt and is preserved as an agent version."
    )]
    pub async fn organize(
        &self,
        Parameters(params): Parameters<OrganizeParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if let Some(refusal) = self.refuse_write() {
            return refusal;
        }
        let args = to_args(&params)?;
        to_tool_result(
            self.bridge
                .call("organize", args, client_of(&ctx), WRITE_TIMEOUT)
                .await,
        )
    }
}

#[tool_handler]
impl ServerHandler for NotaBeneMcpServer {
    fn get_info(&self) -> InitializeResult {
        let mut info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build());
        info.server_info.name = "notabene".into();
        info.server_info.title = Some("NotaBene".into());
        info.server_info.version = env!("CARGO_PKG_VERSION").into();
        info.instructions = Some(
            "Read, search, and write a student's class notes in the live NotaBene app. \
             Call notabene_get_app_state first to learn which note is open. Use \
             notabene_search_notes to find material before writing anything — the query \
             syntax matches the app's own search box. When you create study material \
             (a summary, a revision sheet), file it in the right course and tag it \
             `type:summary` so it is findable later. Every write is versioned and \
             reversible by the user. Before any note-changing operation, pass \
             its current `updatedAt` as `baseUpdatedAt`; if a conflict is returned, \
             read it again before retrying. Trash is recoverable, and there is no \
             permanent-delete or empty-Trash tool. Never rewrite a note wholesale unless the user asked for \
             exactly that."
                .into(),
        );
        info
    }
}
