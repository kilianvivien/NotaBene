//! The AI transport.
//!
//! Provider traffic leaves the machine from here rather than from the webview's
//! `fetch`. The reason is the content security policy: `connect-src` in
//! `tauri.conf.json` is an allowlist, and the point of "bring your own key" is
//! that the user may point NotaBene at an endpoint we have never heard of — a
//! self-hosted vLLM box, a university gateway, a proxy. Shipping a custom base
//! URL behind a `connect-src` wildcard would mean weakening the policy for
//! every other script in the webview; routing through Rust means the policy
//! stays tight and the request still goes where the user asked.
//!
//! This module knows nothing about providers. It carries bytes, mirrors the
//! `AiTransport` interface in TypeScript one to one, and refuses anything that
//! is not plain HTTP(S). Prompt construction, key selection, and response
//! parsing stay in `src/lib/ai/`, which the web build shares.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

/// Event carrying stream frames back to the webview.
pub const AI_STREAM_EVENT: &str = "notabene-ai-stream";

/// Ceiling on a single call. Long enough for a slow local model to think about
/// a long note, short enough that a wedged endpoint does not hang the feature
/// forever. The TypeScript side also has its own, shorter, per-feature timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHttpRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

/// One frame of a streamed response. `kind` is a discriminant rather than three
/// separate events so the webview can route by stream id with one listener.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamFrame {
    stream_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

#[derive(Default)]
pub struct AiShared {
    /// Cancellation handles for calls still running, keyed by the id the
    /// webview minted. Streamed and whole-response calls share the map: both
    /// are a request somebody may want to stop, and a local model spends the
    /// same minute of GPU on either. A cancel that arrives after the call
    /// ended is a no-op, which is the behaviour a cancel button wants.
    calls: Mutex<HashMap<String, CancellationToken>>,
}

/// What a cancelled call returns. The TypeScript side has already rejected by
/// the time this arrives — the value of the trip is that the provider stops.
const CANCELLED: &str = "cancelled";

fn register(state: &State<'_, AiShared>, id: &str) -> Result<CancellationToken, String> {
    let token = CancellationToken::new();
    state
        .calls
        .lock()
        .map_err(|_| "ai state poisoned")?
        .insert(id.to_string(), token.clone());
    Ok(token)
}

fn unregister(state: &State<'_, AiShared>, id: &str) {
    if let Ok(mut calls) = state.calls.lock() {
        calls.remove(id);
    }
}

/// Register shared AI state; called once from the Tauri setup hook.
pub fn init(app: &AppHandle) {
    app.manage(AiShared::default());
}

/// Build a client per call.
///
/// Connection pooling would save a handshake, but a shared client would also
/// pool connections *across providers*, and the user may well have configured
/// one they trust less than another. A fresh client per call keeps them
/// separate, and next to model latency the handshake is noise.
fn client() -> Result<reqwest::Client, String> {
    crate::tls::ensure_provider();

    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())
}

/// Reject anything that is not an ordinary web request before it is built.
///
/// Without this, a compromised webview could ask the Rust side to read
/// `file:///` — which is exactly the reach the CSP is there to deny. Failing
/// here keeps the transport strictly less powerful than the browser's.
fn build(request: &AiHttpRequest) -> Result<reqwest::RequestBuilder, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("refusing scheme \"{}\"", url.scheme()));
    }

    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("refusing method \"{other}\"")),
    };

    let mut builder = client()?.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    Ok(builder)
}

fn header_map(response: &reqwest::Response) -> HashMap<String, String> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|text| (name.as_str().to_string(), text.to_string()))
        })
        .collect()
}

/// A single request/response round trip.
///
/// A non-2xx status is *not* an error here: providers put their most useful
/// diagnostics in the body of a 400, and the TypeScript side needs to read it
/// to tell "your key is wrong" apart from "that model does not exist".
///
/// Cancellable for the same reason a stream is. Every structured feature —
/// rewrite, synthesis, flashcards, mind maps, podcast scripts — asks for one
/// JSON document and so takes this path, and those are exactly the calls a
/// student sitting in front of a local model waits minutes for.
#[tauri::command]
pub async fn ai_request(
    state: State<'_, AiShared>,
    request_id: String,
    request: AiHttpRequest,
) -> Result<AiHttpResponse, String> {
    let token = register(&state, &request_id)?;
    let result = run_request(request, &token).await;
    unregister(&state, &request_id);
    result
}

async fn run_request(
    request: AiHttpRequest,
    token: &CancellationToken,
) -> Result<AiHttpResponse, String> {
    let response = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        sent = build(&request)?.send() => sent.map_err(|error| error.to_string())?,
    };

    let status = response.status().as_u16();
    let headers = header_map(&response);
    // Selected over as well as `send`. Nearly all of the wait is upstream, but
    // a provider that has begun answering slowly is still a provider the user
    // asked us to stop talking to.
    let body = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        text = response.text() => text.map_err(|error| error.to_string())?,
    };
    Ok(AiHttpResponse {
        status,
        headers,
        body,
    })
}

/// Stream a response, emitting each chunk as it arrives.
///
/// Chunks are forwarded raw — server-sent-event framing is parsed in
/// TypeScript, because each provider frames its own way and the parser has to
/// live where the provider code lives.
#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    state: State<'_, AiShared>,
    stream_id: String,
    request: AiHttpRequest,
) -> Result<(), String> {
    let token = register(&state, &stream_id)?;
    let result = run_stream(&app, &stream_id, request, &token).await;
    unregister(&state, &stream_id);

    match result {
        Ok(()) => emit(&app, &stream_id, "done", None),
        Err(message) => emit(&app, &stream_id, "error", Some(message)),
    }
    Ok(())
}

async fn run_stream(
    app: &AppHandle,
    stream_id: &str,
    request: AiHttpRequest,
    token: &CancellationToken,
) -> Result<(), String> {
    let response = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        sent = build(&request)?.send() => sent.map_err(|error| error.to_string())?,
    };

    // An error status arrives as a normal body, not a stream, and the caller
    // needs the text to explain itself.
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("{status} {body}"));
    }

    let mut chunks = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = token.cancelled() => return Err(CANCELLED.into()),
            chunk = chunks.next() => chunk,
        };
        match next {
            None => return Ok(()),
            Some(Err(error)) => return Err(error.to_string()),
            Some(Ok(bytes)) => {
                // Providers stream UTF-8, but a chunk boundary can land inside
                // a multi-byte character. Lossy decoding would corrupt an
                // accented word silently, so hold the tail back instead — the
                // webview reassembles frames anyway.
                match std::str::from_utf8(&bytes) {
                    Ok(text) => emit(app, stream_id, "chunk", Some(text.to_string())),
                    Err(error) => {
                        let (valid, _) = bytes.split_at(error.valid_up_to());
                        if !valid.is_empty() {
                            emit(
                                app,
                                stream_id,
                                "chunk",
                                Some(String::from_utf8_lossy(valid).into_owned()),
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Cancel an in-flight call, streamed or not. Unknown ids are ignored on
/// purpose: the user pressing Cancel as the last token lands should not see an
/// error.
#[tauri::command]
pub fn ai_cancel(state: State<'_, AiShared>, id: String) -> Result<(), String> {
    let mut calls = state.calls.lock().map_err(|_| "ai state poisoned")?;
    if let Some(token) = calls.remove(&id) {
        token.cancel();
    }
    Ok(())
}

fn emit(app: &AppHandle, stream_id: &str, kind: &'static str, data: Option<String>) {
    let _ = app.emit(
        AI_STREAM_EVENT,
        AiStreamFrame {
            stream_id: stream_id.to_string(),
            kind,
            data,
        },
    );
}
