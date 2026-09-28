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
//!
//! **It is not an open proxy** (security review 2026-09, item 8). A request
//! goes to a hosted provider this file names, to loopback (a local runtime),
//! or to an origin the student allowed in a native dialog — asked the first
//! time, remembered in `ai-origins.json`, which only this module writes. The
//! allowance cannot come from settings: the webview writes those, and a
//! compromised page that could add its own endpoint would make the check
//! decorative.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use std::collections::HashSet;
use std::net::IpAddr;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
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
    /// A transcription window to send as `multipart/form-data` (plan §10.3).
    /// It *names* the audio — a job and a window — and Rust reads the file,
    /// so a lecture never passes through the webview on its way out.
    #[serde(default)]
    audio: Option<AiAudioBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAudioBody {
    /// Plain form fields, in order. A name may repeat — that is how a list
    /// such as `context_bias` travels in a form.
    fields: Vec<(String, String)>,
    file_field: String,
    job_id: String,
    index: usize,
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

/// Hosted providers' origins, from their default base URLs in
/// `src/lib/ai/providers.ts`. Keep the two in step.
const BUILT_IN_ORIGINS: &[&str] = &[
    "https://api.anthropic.com",
    "https://api.openai.com",
    "https://api.mistral.ai",
    "https://generativelanguage.googleapis.com",
    "https://openrouter.ai",
];

const ORIGINS_FILE: &str = "ai-origins.json";

/// `scheme://host[:port]`, the unit a student allows.
fn origin_of(url: &reqwest::Url) -> String {
    url.origin().ascii_serialization()
}

/// A local runtime: Ollama, LM Studio, the managed Apple model server.
fn is_loopback(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    // `host_str` keeps an IPv6 literal's brackets (see `web.rs`).
    let literal = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    literal.eq_ignore_ascii_case("localhost")
        || literal
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[derive(Default)]
struct Origins {
    allowed: HashSet<String>,
    /// Declined this session. Not remembered across launches: a mistaken
    /// "no" should not need a settings page to undo.
    declined: HashSet<String>,
}

#[derive(Default)]
pub struct AiShared {
    origins: Mutex<Origins>,
    /// One question at a time: a settings page that lists a new endpoint's
    /// models while testing it would otherwise open two dialogs at once.
    asking: tokio::sync::Mutex<()>,
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
    let shared = AiShared::default();
    if let Ok(mut origins) = shared.origins.lock() {
        origins.allowed = read_allowed(app);
    }
    app.manage(shared);
}

fn origins_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::settings::data_dir(app)
        .ok()
        .map(|dir| dir.join(ORIGINS_FILE))
}

fn read_allowed(app: &AppHandle) -> HashSet<String> {
    origins_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .map(|list| list.into_iter().collect())
        .unwrap_or_default()
}

fn write_allowed(app: &AppHandle, allowed: &HashSet<String>) {
    let mut list: Vec<&String> = allowed.iter().collect();
    list.sort();
    if let (Some(path), Ok(text)) = (origins_path(app), serde_json::to_string_pretty(&list)) {
        let _ = std::fs::write(path, text);
    }
}

/// Whether the dialog speaks French: the app's own language setting, read
/// here because Rust cannot ask the webview for words it would then trust.
fn french(app: &AppHandle) -> bool {
    crate::settings::data_dir(app)
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|settings| settings.get("locale")?.as_str().map(str::to_owned))
        .is_some_and(|locale| locale.starts_with("fr"))
}

/// May this request leave? Hosted providers and loopback always; anything
/// else once the student has said so.
async fn permit(app: &AppHandle, state: &AiShared, url: &reqwest::Url) -> Result<(), String> {
    let origin = origin_of(url);
    if is_loopback(url) || BUILT_IN_ORIGINS.contains(&origin.as_str()) {
        return Ok(());
    }
    let decided = |state: &AiShared| -> Result<Option<bool>, String> {
        let origins = state.origins.lock().map_err(|_| "ai state poisoned")?;
        Ok(if origins.allowed.contains(&origin) {
            Some(true)
        } else if origins.declined.contains(&origin) {
            Some(false)
        } else {
            None
        })
    };
    let declined = || format!("origin_declined:NotaBene was not allowed to contact {origin}");
    match decided(state)? {
        Some(true) => return Ok(()),
        Some(false) => return Err(declined()),
        None => {}
    }

    let _asking = state.asking.lock().await;
    // Another request may have asked while this one waited.
    match decided(state)? {
        Some(true) => return Ok(()),
        Some(false) => return Err(declined()),
        None => {}
    }

    let (title, message, allow, deny) = if french(app) {
        (
            "Autoriser ce fournisseur d’IA ?".to_string(),
            format!(
                "NotaBene va envoyer le contenu de vos notes à :\n\n{origin}\n\nC’est l’adresse d’un fournisseur que vous avez configuré. N’autorisez que si vous la reconnaissez."
            ),
            "Autoriser",
            "Refuser",
        )
    } else {
        (
            "Allow this AI provider?".to_string(),
            format!(
                "NotaBene is about to send the content of your notes to:\n\n{origin}\n\nThis is the address of a provider you configured. Allow it only if you recognise it."
            ),
            "Allow",
            "Don’t allow",
        )
    };
    let dialog = app.clone();
    let allowed = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                allow.into(),
                deny.into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|error| error.to_string())?;

    let mut origins = state.origins.lock().map_err(|_| "ai state poisoned")?;
    if allowed {
        origins.allowed.insert(origin);
        write_allowed(app, &origins.allowed);
        Ok(())
    } else {
        origins.declined.insert(origin.clone());
        Err(declined())
    }
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
fn parse_url(request: &AiHttpRequest) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("refusing scheme \"{}\"", url.scheme()));
    }
    Ok(url)
}

/// A form field name: nothing that could close the quoted parameter it sits
/// in, or start a header of its own.
fn check_field_name(name: &str) -> Result<(), String> {
    let valid = (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '[' | ']'));
    if valid {
        Ok(())
    } else {
        Err(format!("invalid form field {name:?}"))
    }
}

/// `multipart/form-data` by hand: the fields, then the window as
/// `window.m4a`. The boundary is random, so no field value can forge one.
fn multipart_body(audio: &AiAudioBody, file: &[u8]) -> Result<(String, Vec<u8>), String> {
    check_field_name(&audio.file_field)?;
    let boundary = format!("notabene-{:032x}", rand::random::<u128>());
    let mut body = Vec::with_capacity(file.len() + 1024);
    for (name, value) in &audio.fields {
        check_field_name(name)?;
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"window.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n",
            audio.file_field
        )
        .as_bytes(),
    );
    body.extend_from_slice(file);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

/// The encoded window and its form, when the request carries audio. Audio
/// goes only to a hosted provider this file names: a transcription engine
/// is chosen from a fixed list, and no configured endpoint is one of them.
async fn audio_body(
    app: &AppHandle,
    request: &AiHttpRequest,
    url: &reqwest::Url,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let Some(audio) = &request.audio else {
        return Ok(None);
    };
    if !BUILT_IN_ORIGINS.contains(&origin_of(url).as_str()) {
        return Err("audio is only sent to a built-in provider".into());
    }
    if request.body.is_some() {
        return Err("a request carries a body or audio, not both".into());
    }
    let file = crate::asr::window_aac(app, &audio.job_id, audio.index).await?;
    multipart_body(audio, &file).map(Some)
}

fn build(
    request: &AiHttpRequest,
    multipart: Option<(String, Vec<u8>)>,
) -> Result<reqwest::RequestBuilder, String> {
    let url = parse_url(request)?;

    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("refusing method \"{other}\"")),
    };

    let mut builder = client()?.request(method, url);
    for (name, value) in &request.headers {
        // The form sets its own type, boundary included.
        if multipart.is_some() && name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        builder = builder.header(name, value);
    }
    if let Some((content_type, bytes)) = multipart {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(bytes);
    } else if let Some(body) = &request.body {
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
    app: AppHandle,
    state: State<'_, AiShared>,
    request_id: String,
    request: AiHttpRequest,
) -> Result<AiHttpResponse, String> {
    let url = parse_url(&request)?;
    permit(&app, &state, &url).await?;
    let multipart = audio_body(&app, &request, &url).await?;
    let token = register(&state, &request_id)?;
    let result = run_request(request, multipart, &token).await;
    unregister(&state, &request_id);
    result
}

async fn run_request(
    request: AiHttpRequest,
    multipart: Option<(String, Vec<u8>)>,
    token: &CancellationToken,
) -> Result<AiHttpResponse, String> {
    let response = tokio::select! {
        _ = token.cancelled() => return Err(CANCELLED.into()),
        sent = build(&request, multipart)?.send() => sent.map_err(|error| error.to_string())?,
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
    if request.audio.is_some() {
        emit(&app, &stream_id, "error", Some("audio is not streamed".into()));
        return Ok(());
    }
    if let Err(message) = permit(&app, &state, &parse_url(&request)?).await {
        emit(&app, &stream_id, "error", Some(message));
        return Ok(());
    }
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
        sent = build(&request, None)?.send() => sent.map_err(|error| error.to_string())?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> reqwest::Url {
        reqwest::Url::parse(text).unwrap()
    }

    #[test]
    fn local_runtimes_are_loopback_and_nothing_else_is() {
        for local in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:1976/v1",
            "http://[::1]:1234/v1",
            "http://LOCALHOST:8080",
        ] {
            assert!(is_loopback(&url(local)), "{local}");
        }
        for remote in [
            "http://192.168.1.10:11434",
            "https://localhost.evil.com",
            "https://api.openai.com/v1",
        ] {
            assert!(!is_loopback(&url(remote)), "{remote}");
        }
    }

    fn audio(fields: &[(&str, &str)]) -> AiAudioBody {
        AiAudioBody {
            fields: fields
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            file_field: "file".into(),
            job_id: "job1".into(),
            index: 0,
        }
    }

    #[test]
    fn a_form_repeats_list_fields_and_carries_the_window_last() {
        let (content_type, body) = multipart_body(
            &audio(&[
                ("model", "voxtral-mini-2602"),
                ("context_bias", "Calvin"),
                ("context_bias", "photosynthèse"),
            ]),
            b"AUDIO",
        )
        .unwrap();
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();
        let text = String::from_utf8(body).unwrap();
        assert_eq!(text.matches("name=\"context_bias\"").count(), 2);
        assert!(text.contains("photosynthèse"));
        let file = text.find("filename=\"window.m4a\"").unwrap();
        assert!(text.find("name=\"model\"").unwrap() < file);
        assert!(text.ends_with(&format!("AUDIO\r\n--{boundary}--\r\n")));
    }

    #[test]
    fn a_field_name_cannot_break_out_of_its_header() {
        for bad in ["x\"; filename=\"y", "a\r\nb", "", "a b"] {
            assert!(multipart_body(&audio(&[(bad, "v")]), b"").is_err(), "{bad:?}");
        }
        let mut body = audio(&[]);
        body.file_field = "file\"".into();
        assert!(multipart_body(&body, b"").is_err());
    }

    #[test]
    fn an_origin_is_scheme_host_and_port_only() {
        assert_eq!(
            origin_of(&url("https://api.anthropic.com/v1/messages?x=1")),
            "https://api.anthropic.com"
        );
        assert!(BUILT_IN_ORIGINS.contains(
            &origin_of(&url(
                "https://generativelanguage.googleapis.com/v1beta/models"
            ))
            .as_str()
        ));
        // A lookalike is not the provider.
        assert!(!BUILT_IN_ORIGINS
            .contains(&origin_of(&url("https://api.openai.com.evil.com/v1")).as_str()));
        assert_eq!(
            origin_of(&url("https://gateway.example.edu:8443/v1")),
            "https://gateway.example.edu:8443"
        );
    }
}
