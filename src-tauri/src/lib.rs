//! NotaBene's desktop shell.
//!
//! The Rust side owns three things the web layer cannot: the SQLite note store,
//! the loopback MCP server, and (later) the native bridges for TTS, Spotlight,
//! and QuickLook. Everything else — the editor, rendering, export composition,
//! AI orchestration — stays in TypeScript so the core remains web-ready.

mod ai;
mod commands;
mod db;
mod mcp;
mod menu;
mod settings;
mod tts;

use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Menu clicks carry no behaviour here — the id goes straight to the
        // webview, which runs it through the same command router a keyboard
        // shortcut uses. See `src/lib/commands/appCommands.ts`.
        .on_menu_event(|app, event| {
            let _ = app.emit(menu::MENU_COMMAND_EVENT, event.id().0.clone());
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && shortcut.matches(
                            tauri_plugin_global_shortcut::Modifiers::SUPER
                                | tauri_plugin_global_shortcut::Modifiers::SHIFT,
                            tauri_plugin_global_shortcut::Code::KeyQ,
                        )
                    {
                        let _ = app.emit(menu::MENU_COMMAND_EVENT, "note.quick");
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();

            // Opening the store runs migrations. Failing here is fatal on
            // purpose: a note app that cannot reach its library should say so
            // loudly rather than start up looking empty.
            let path = db::database_path(handle)?;
            let store = db::Store::open(&path)?;
            app.manage(store);

            #[cfg(desktop)]
            app.global_shortcut().register("CmdOrCtrl+Shift+Q")?;

            // Unlike the store, a failed secrets migration is not fatal: the
            // keys are still readable where they are, and refusing to launch
            // over housekeeping would be the worse outcome.
            if let Err(error) = settings::migrate_secrets(handle) {
                eprintln!("secrets migration skipped: {error}");
            }

            ai::init(handle);
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
            commands::library_list_backlinks,
            commands::library_list_tags,
            commands::library_upsert_tag,
            commands::library_delete_tag,
            commands::library_merge_tags,
            commands::library_list_snapshots,
            commands::library_get_snapshot,
            commands::library_create_snapshot,
            commands::library_prune_snapshots,
            commands::library_purge_trash,
            commands::journal_write,
            commands::journal_pending,
            commands::journal_discard,
            commands::library_list_attachments,
            commands::library_upsert_attachment,
            commands::library_delete_attachment,
            commands::library_list_assets,
            commands::assets_put,
            commands::assets_get,
            commands::assets_stat,
            commands::assets_collect_garbage,
            commands::library_list_saved_searches,
            commands::library_upsert_saved_search,
            commands::library_delete_saved_search,
            commands::library_list_templates,
            commands::library_upsert_template,
            commands::library_delete_template,
            commands::library_export,
            commands::library_import,
            commands::export_write,
            settings::settings_load,
            settings::settings_save,
            settings::secrets_get,
            settings::secrets_set,
            settings::secrets_remove,
            settings::secrets_list_keys,
            ai::ai_request,
            ai::ai_stream,
            ai::ai_cancel,
            tts::tts_system_available,
            tts::tts_system_voices,
            tts::tts_system_synthesize,
            menu::menu_apply,
            mcp::mcp_start_server,
            mcp::mcp_stop_server,
            mcp::mcp_server_status,
            mcp::mcp_bridge_respond,
            mcp::mcp_write_client_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NotaBene");
}
