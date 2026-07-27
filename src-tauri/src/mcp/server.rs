//! Lifecycle of the embedded loopback MCP server.
//!
//! Binds `127.0.0.1` only (default port 22600, scanning up on conflict) and
//! requires the pairing token as a Bearer header on every request. The rmcp
//! transport additionally enforces loopback `Host` values, which shuts the door
//! on DNS rebinding at the protocol level.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use super::bridge::McpBridge;
use super::tools::NotaBeneMcpServer;

/// How many ports above the preferred one to try before giving up.
const PORT_SCAN_RANGE: u16 = 10;
/// A student can leave an agent connected across a whole study session; rmcp's
/// five-minute default would collect it mid-task.
const SESSION_KEEP_ALIVE: Duration = Duration::from_secs(24 * 60 * 60);

pub struct ServerHandle {
    pub port: u16,
    cancel: CancellationToken,
    running: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl ServerHandle {
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }

    pub fn status(&self) -> (bool, Option<String>) {
        (
            self.running.load(Ordering::Relaxed),
            self.error
                .lock()
                .expect("mcp server error lock poisoned")
                .clone(),
        )
    }
}

fn has_expected_bearer(headers: &axum::http::HeaderMap, expected: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected)
}

async fn require_bearer(
    State(expected): State<Arc<String>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let authorized = has_expected_bearer(request.headers(), expected.as_str());
    if authorized {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn emit_status(app: &AppHandle, running: bool, port: Option<u16>, error: Option<String>) {
    let _ = app.emit_to(
        "main",
        "notabene-mcp-status",
        serde_json::json!({ "running": running, "port": port, "error": error }),
    );
}

/// Bind the loopback listener and spawn the HTTP server task.
pub async fn start_server(
    app: AppHandle,
    bridge: Arc<McpBridge>,
    token: String,
    preferred_port: u16,
) -> Result<ServerHandle, String> {
    let mut bound = None;
    for port in preferred_port..=preferred_port.saturating_add(PORT_SCAN_RANGE) {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                bound = Some((listener, port));
                break;
            }
            Err(_) => continue,
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!(
            "no free loopback port between {preferred_port} and {}",
            preferred_port.saturating_add(PORT_SCAN_RANGE)
        )
    })?;

    let cancel = CancellationToken::new();
    let config = StreamableHttpServerConfig::default()
        .with_cancellation_token(cancel.clone())
        // Keep this explicit instead of relying on rmcp's secure default: the
        // accepted authorities are part of NotaBene's threat model and should
        // remain visible when the dependency changes.
        .with_allowed_hosts([
            "127.0.0.1".to_string(),
            "localhost".to_string(),
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
        ]);
    let mut session_manager = LocalSessionManager::default();
    session_manager.session_config.keep_alive = Some(SESSION_KEEP_ALIVE);
    let service = StreamableHttpService::new(
        move || Ok(NotaBeneMcpServer::new(bridge.clone())),
        Arc::new(session_manager),
        config,
    );
    let router = axum::Router::new().nest_service("/mcp", service).layer(
        axum::middleware::from_fn_with_state(Arc::new(token), require_bearer),
    );

    let shutdown = cancel.clone();
    let task_app = app.clone();
    let running = Arc::new(AtomicBool::new(true));
    let task_running = running.clone();
    let error = Arc::new(Mutex::new(None));
    let task_error = error.clone();
    tauri::async_runtime::spawn(async move {
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await;
        task_running.store(false, Ordering::Relaxed);
        let message = served.err().map(|err| err.to_string());
        *task_error.lock().expect("mcp server error lock poisoned") = message.clone();
        emit_status(&task_app, false, None, message);
    });

    emit_status(&app, true, Some(port), None);
    Ok(ServerHandle {
        port,
        cancel,
        running,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::has_expected_bearer;
    use axum::http::{header, HeaderMap, HeaderValue};

    #[test]
    fn bearer_token_is_required_and_must_match_exactly() {
        let mut headers = HeaderMap::new();
        assert!(!has_expected_bearer(&headers, "correct-token"));

        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer wrong-token"),
        );
        assert!(!has_expected_bearer(&headers, "correct-token"));

        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer correct-token"),
        );
        assert!(has_expected_bearer(&headers, "correct-token"));
    }
}
