//! One-click client setup.
//!
//! Writing the config for the user is the difference between "agent access" being
//! a feature and being a support ticket. We only ever add or replace NotaBene's
//! own entry, and we never read the rest of the file for anything but preserving
//! it — a student's other MCP servers are none of our business.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

fn config_path(client: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("could not locate the home directory")?;
    match client {
        // Claude Code reads `~/.claude.json`.
        "claude-code" => Ok(home.join(".claude.json")),
        "claude-desktop" => Ok(home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json")),
        other => Err(format!("unknown MCP client: {other}")),
    }
}

fn server_entry(port: u16, token: &str) -> Value {
    json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "headers": { "Authorization": format!("Bearer {token}") }
    })
}

fn write_private_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension("notabene-tmp");
    fs::write(&temporary, contents).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|err| err.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|err| err.to_string())
}

/// Add or replace the `notabene` entry in the client's config, returning the
/// path written. For `custom`, nothing is written and the JSON snippet is
/// returned for the user to paste.
pub fn write_client_config(client: &str, port: u16, token: &str) -> Result<String, String> {
    if token.trim().len() < 16 {
        return Err("refusing to write a weak pairing token".into());
    }
    if client == "custom" {
        return serde_json::to_string_pretty(&json!({
            "mcpServers": { "notabene": server_entry(port, token) }
        }))
        .map_err(|err| err.to_string());
    }

    let path = config_path(client)?;
    let mut root: Value = match fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text).map_err(|err| {
            format!(
                "{} is not valid JSON ({err}); fix or move it first",
                path.display()
            )
        })?,
        // A missing file is fine — a malformed one is not, and is handled above.
        _ => Value::Object(Map::new()),
    };

    let object = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("mcpServers is not a JSON object")?;
    servers.insert("notabene".into(), server_entry(port, token));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    write_private_atomic(
        &path,
        &serde_json::to_string_pretty(&root).map_err(|err| err.to_string())?,
    )?;

    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::write_client_config;

    #[test]
    fn custom_snippet_contains_http_endpoint_and_bearer_header() {
        let snippet = write_client_config("custom", 22600, "0123456789abcdef0123456789abcdef")
            .expect("custom config");
        let value: serde_json::Value = serde_json::from_str(&snippet).expect("valid json");
        let entry = &value["mcpServers"]["notabene"];
        assert_eq!(entry["type"], "http");
        assert_eq!(entry["url"], "http://127.0.0.1:22600/mcp");
        assert_eq!(
            entry["headers"]["Authorization"],
            "Bearer 0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn weak_tokens_are_never_written() {
        assert!(write_client_config("custom", 22600, "too-short").is_err());
    }
}
