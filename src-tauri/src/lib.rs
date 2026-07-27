//! NotaBene's desktop shell.
//!
//! The Rust side owns three things the web layer cannot: the SQLite note store,
//! the loopback MCP server, and (later) the native bridges for TTS, Spotlight,
//! and QuickLook. Everything else — the editor, rendering, export composition,
//! AI orchestration — stays in TypeScript so the core remains web-ready.

mod commands;
mod db;
mod mcp;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle();

            // Opening the store runs migrations. Failing here is fatal on
            // purpose: a note app that cannot reach its library should say so
            // loudly rather than start up looking empty.
            let path = db::database_path(handle)?;
            let store = db::Store::open(&path)?;
            app.manage(store);

            mcp::init(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_init,
            commands::library_list_courses,
            commands::library_upsert_course,
            commands::library_delete_course,
            commands::library_list_sections,
            commands::library_upsert_section,
            commands::library_delete_section,
            commands::library_query_notes,
            commands::library_get_note,
            commands::library_upsert_note,
            commands::library_trash_note,
            commands::library_restore_note,
            commands::library_purge_note,
            commands::library_list_tags,
            commands::library_upsert_tag,
            commands::library_delete_tag,
            commands::library_merge_tags,
            commands::library_list_snapshots,
            commands::library_get_snapshot,
            commands::library_create_snapshot,
            commands::library_prune_snapshots,
            commands::library_list_attachments,
            commands::library_list_assets,
            commands::library_list_saved_searches,
            commands::library_list_templates,
            commands::library_export,
            mcp::mcp_start_server,
            mcp::mcp_stop_server,
            mcp::mcp_server_status,
            mcp::mcp_bridge_respond,
            mcp::mcp_write_client_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NotaBene");
}
