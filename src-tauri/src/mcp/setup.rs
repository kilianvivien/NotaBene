//! One-click client setup.
//!
//! Writing the config for the user is the difference between "agent access" being
//! a feature and being a support ticket. We only ever add or replace NotaBene's
//! own entry, and we never read the rest of the file for anything but preserving
//! it — a student's other MCP servers are none of our business.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

/// What a client's config file looks like.
///
/// The five JSON clients agree on almost nothing beyond "it is JSON": Claude
/// nests under `mcpServers` and calls the address `url`, Antigravity nests
/// under `mcpServers` but insists on `serverUrl` and rejects `url` outright,
/// and OpenCode nests under `mcp` and wants an explicit `type: "remote"`.
/// Encoding the differences as data rather than as branches is what keeps
/// `write_client_config` one function, and what makes adding the sixth client a
/// row rather than an edit.
struct JsonShape {
    /// Top-level key holding the map of servers.
    container: &'static str,
    entry: fn(u16, &str) -> Value,
}

fn claude_entry(port: u16, token: &str) -> Value {
    json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "headers": { "Authorization": format!("Bearer {token}") }
    })
}

/// Antigravity documents `url` and `httpUrl` as unsupported legacy fields; the
/// address goes in `serverUrl` or the server is simply not found.
fn antigravity_entry(port: u16, token: &str) -> Value {
    json!({
        "serverUrl": format!("http://127.0.0.1:{port}/mcp"),
        "headers": { "Authorization": format!("Bearer {token}") }
    })
}

/// `oauth: false` matters: OpenCode attempts an OAuth handshake against a
/// remote server by default, and NotaBene's is a bearer-token server that would
/// fail that handshake before ever reading the header it was given.
fn opencode_entry(port: u16, token: &str) -> Value {
    json!({
        "type": "remote",
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "enabled": true,
        "oauth": false,
        "headers": { "Authorization": format!("Bearer {token}") }
    })
}

fn json_client(client: &str) -> Result<(PathBuf, JsonShape), String> {
    let home = dirs::home_dir().ok_or("could not locate the home directory")?;
    let shape = |container, entry: fn(u16, &str) -> Value| JsonShape { container, entry };

    match client {
        // Claude Code reads `~/.claude.json`.
        "claude-code" => Ok((home.join(".claude.json"), shape("mcpServers", claude_entry))),
        "claude-desktop" => Ok((
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
            shape("mcpServers", claude_entry),
        )),
        "antigravity" => Ok((
            home.join(".gemini").join("antigravity").join("mcp_config.json"),
            shape("mcpServers", antigravity_entry),
        )),
        "opencode" => Ok((
            home.join(".config").join("opencode").join("opencode.json"),
            shape("mcp", opencode_entry),
        )),
        other => Err(format!("unknown MCP client: {other}")),
    }
}

/// Codex, which is the only client here that is not JSON.
///
/// `toml_edit` rather than `toml`: `~/.codex/config.toml` is a file people hand-
/// edit and comment, and a round trip through a plain serialiser would silently
/// reformat the whole thing and drop every comment in it. `http_headers` rather
/// than `bearer_token_env_var` because the latter names an environment variable
/// this app has no way to set in the shell the user will run Codex from.
fn write_codex_config(port: u16, token: &str) -> Result<String, String> {
    let path = dirs::home_dir()
        .ok_or("could not locate the home directory")?
        .join(".codex")
        .join("config.toml");

    let mut document = match fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            text.parse::<toml_edit::DocumentMut>().map_err(|err| {
                format!(
                    "{} is not valid TOML ({err}); fix or move it first",
                    path.display()
                )
            })?
        }
        _ => toml_edit::DocumentMut::new(),
    };

    let mut headers = toml_edit::InlineTable::new();
    headers.insert("Authorization", format!("Bearer {token}").into());

    let mut entry = toml_edit::Table::new();
    entry.insert(
        "url",
        toml_edit::value(format!("http://127.0.0.1:{port}/mcp")),
    );
    entry.insert("http_headers", toml_edit::value(headers));

    let servers = document
        .entry("mcp_servers")
        .or_insert(toml_edit::Item::Table({
            let mut table = toml_edit::Table::new();
            // Implicit so the file reads as `[mcp_servers.notabene]` and not as
            // an empty `[mcp_servers]` header above it.
            table.set_implicit(true);
            table
        }))
        .as_table_mut()
        .ok_or("mcp_servers is not a TOML table")?;
    servers.insert("notabene", toml_edit::Item::Table(entry));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    write_private_atomic(&path, &document.to_string())?;
    Ok(path.display().to_string())
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
            "mcpServers": { "notabene": claude_entry(port, token) }
        }))
        .map_err(|err| err.to_string());
    }
    if client == "codex" {
        return write_codex_config(port, token);
    }

    let (path, shape) = json_client(client)?;
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
        .entry(shape.container)
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", shape.container))?;
    servers.insert("notabene".into(), (shape.entry)(port, token));

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
    use super::{antigravity_entry, opencode_entry, write_client_config};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    /// Antigravity documents `url` and `httpUrl` as legacy and unsupported, so
    /// getting this field name wrong produces a config the IDE accepts and then
    /// never connects with.
    #[test]
    fn antigravity_addresses_the_server_with_server_url_only() {
        let entry = antigravity_entry(22600, TOKEN);
        assert_eq!(entry["serverUrl"], "http://127.0.0.1:22600/mcp");
        assert!(entry.get("url").is_none());
        assert!(entry.get("httpUrl").is_none());
        assert_eq!(entry["headers"]["Authorization"], format!("Bearer {TOKEN}"));
    }

    /// OpenCode tries OAuth against a remote server unless told not to, which
    /// fails before the bearer header is ever read.
    #[test]
    fn opencode_declares_a_remote_server_and_opts_out_of_oauth() {
        let entry = opencode_entry(22600, TOKEN);
        assert_eq!(entry["type"], "remote");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["oauth"], false);
        assert_eq!(entry["headers"]["Authorization"], format!("Bearer {TOKEN}"));
    }

    #[test]
    fn unknown_clients_are_refused_rather_than_written_somewhere() {
        assert!(write_client_config("cursor", 22600, TOKEN).is_err());
    }

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
