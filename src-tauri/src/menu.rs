//! The native macOS menu bar.
//!
//! The shell does not know what NotaBene's commands are. The webview sends a
//! menu description — ids, labels, accelerators, enabled state — and this
//! module turns it into an `NSMenu`; every click comes back as a
//! `notabene-menu-command` event carrying the id.
//!
//! That direction matters. The ids are the same `APP_COMMAND_IDS` the web
//! command router dispatches on (`src/lib/commands/appCommands.ts`), so the
//! menu cannot drift from the commands, and the labels arrive already
//! translated by i18next instead of needing a second FR/EN table over here.
//! Re-sending the description is also how the menu follows a language change.

use serde::Deserialize;
use tauri::AppHandle;

/// Emitted on every menu click. The webview routes it through the same command
/// function a keyboard shortcut or a button would call.
pub const MENU_COMMAND_EVENT: &str = "notabene-menu-command";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuNode {
    /// A NotaBene command. `id` is an `AppCommandId`.
    Item {
        id: String,
        label: String,
        accelerator: Option<String>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
    /// A system role — undo, copy, minimize, quit. These must be predefined
    /// items rather than our own: the OS wires them to the responder chain,
    /// which is what makes Cmd-C work inside a text field we do not own.
    Predefined { role: String, label: Option<String> },
    Separator,
    Submenu { label: String, items: Vec<MenuNode> },
}

fn enabled_by_default() -> bool {
    true
}

/// Replace the application menu. Called once at startup and again whenever the
/// locale changes.
#[tauri::command]
pub fn menu_apply(app: AppHandle, menu: Vec<MenuNode>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        desktop::apply(&app, &menu)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, menu);
        Err("native menus are desktop-only".into())
    }
}

#[cfg(desktop)]
mod desktop {
    use super::MenuNode;
    use tauri::menu::{IsMenuItem, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    use tauri::{AppHandle, Wry};

    pub fn apply(app: &AppHandle, nodes: &[MenuNode]) -> Result<(), String> {
        let mut builder = MenuBuilder::new(app);

        // macOS only accepts submenus at the top level; anything else here is a
        // bug in the description, and saying so beats rendering half a menu.
        for node in nodes {
            match node {
                MenuNode::Submenu { label, items } => {
                    let submenu = build_submenu(app, label, items)?;
                    builder = builder.item(&submenu);
                }
                _ => return Err("the menu bar accepts only submenus at its top level".into()),
            }
        }

        let menu = builder.build().map_err(|error| error.to_string())?;
        app.set_menu(menu).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn build_submenu(
        app: &AppHandle,
        label: &str,
        items: &[MenuNode],
    ) -> Result<tauri::menu::Submenu<Wry>, String> {
        let mut builder = SubmenuBuilder::new(app, label);

        for node in items {
            // Each arm owns its item for the length of the loop body, so the
            // borrow handed to the builder outlives nothing.
            let item: Box<dyn IsMenuItem<Wry>> = match node {
                MenuNode::Item {
                    id,
                    label,
                    accelerator,
                    enabled,
                } => {
                    let mut item = MenuItemBuilder::with_id(id.clone(), label).enabled(*enabled);
                    if let Some(accelerator) = accelerator {
                        item = item.accelerator(accelerator);
                    }
                    Box::new(item.build(app).map_err(|error| error.to_string())?)
                }
                MenuNode::Predefined { role, label } => {
                    Box::new(predefined(app, role, label.as_deref())?)
                }
                MenuNode::Separator => Box::new(
                    PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
                ),
                MenuNode::Submenu { label, items } => Box::new(build_submenu(app, label, items)?),
            };
            builder = builder.item(item.as_ref());
        }

        builder.build().map_err(|error| error.to_string())
    }

    fn predefined(
        app: &AppHandle,
        role: &str,
        label: Option<&str>,
    ) -> Result<PredefinedMenuItem<Wry>, String> {
        let item = match role {
            "about" => PredefinedMenuItem::about(app, label, None),
            "services" => PredefinedMenuItem::services(app, label),
            "hide" => PredefinedMenuItem::hide(app, label),
            "hideOthers" => PredefinedMenuItem::hide_others(app, label),
            "showAll" => PredefinedMenuItem::show_all(app, label),
            "quit" => PredefinedMenuItem::quit(app, label),
            "undo" => PredefinedMenuItem::undo(app, label),
            "redo" => PredefinedMenuItem::redo(app, label),
            "cut" => PredefinedMenuItem::cut(app, label),
            "copy" => PredefinedMenuItem::copy(app, label),
            "paste" => PredefinedMenuItem::paste(app, label),
            "selectAll" => PredefinedMenuItem::select_all(app, label),
            "minimize" => PredefinedMenuItem::minimize(app, label),
            "maximize" => PredefinedMenuItem::maximize(app, label),
            "fullscreen" => PredefinedMenuItem::fullscreen(app, label),
            "closeWindow" => PredefinedMenuItem::close_window(app, label),
            "bringAllToFront" => PredefinedMenuItem::bring_all_to_front(app, label),
            other => return Err(format!("unknown predefined menu role \"{other}\"")),
        };
        item.map_err(|error| error.to_string())
    }
}
