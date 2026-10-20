//! Ephemeral Voxtral 3 dictation. No audio file is written. The fixed provider
//! endpoint keeps credentials and WebSockets outside the webview's CSP.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio::time::{timeout, Instant};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type Active = Arc<Mutex<Option<Session>>>;

#[derive(Default)]
pub struct DictationState(Active, Mutex<Option<String>>);

struct Session {
    id: String,
    audio: mpsc::Sender<Option<String>>,
    cancel: CancellationToken,
}

async fn send(socket: &mut Socket, value: Value) -> Result<(), String> {
    timeout(
        Duration::from_secs(5),
        socket.send(Message::text(value.to_string())),
    )
    .await
    .map_err(|_| "DICTATION_TIMEOUT")?
    .map_err(|_| "DICTATION_CONNECTION".into())
}

async fn event(socket: &mut Socket) -> Result<Value, String> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let value: Value = serde_json::from_str(&text).map_err(|_| "DICTATION_RESPONSE")?;
                if value["type"] == "error" {
                    return Err("DICTATION_PROVIDER".into());
                }
                return Ok(value);
            }
            Some(Ok(Message::Ping(_))) => {
                socket.flush().await.map_err(|_| "DICTATION_CONNECTION")?;
            }
            Some(Ok(Message::Pong(_))) => {}
            _ => return Err("DICTATION_CONNECTION".into()),
        }
    }
}

async fn wait_for(socket: &mut Socket, kind: &str) -> Result<(), String> {
    timeout(Duration::from_secs(15), async {
        loop {
            if event(socket).await?["type"] == kind {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| "DICTATION_TIMEOUT")?
}

fn configuration(sample_rate: u32, vocabulary: Vec<String>) -> Value {
    json!({
        "type": "session.update",
        "session": {
            "audio_format": { "encoding": "pcm_s16le", "sample_rate": sample_rate },
            "target_streaming_delay_ms": 480,
            "context_bias": vocabulary,
        }
    })
}

async fn run(
    key: String,
    sample_rate: u32,
    vocabulary: Vec<String>,
    audio: mpsc::Receiver<Option<String>>,
    output: Channel<Value>,
) -> Result<(), String> {
    let mut request = "wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-3-0"
        .into_client_request().map_err(|_| "DICTATION_CONNECTION")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {key}")
            .parse()
            .map_err(|_| "DICTATION_KEY")?,
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(2 * 1024 * 1024))
        .max_frame_size(Some(2 * 1024 * 1024));
    let (socket, _) = timeout(
        Duration::from_secs(15),
        connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| "DICTATION_TIMEOUT")?
    .map_err(|_| "DICTATION_CONNECTION")?;
    stream(socket, sample_rate, vocabulary, audio, output).await
}

async fn stream(
    mut socket: Socket,
    sample_rate: u32,
    vocabulary: Vec<String>,
    mut audio: mpsc::Receiver<Option<String>>,
    output: Channel<Value>,
) -> Result<(), String> {
    wait_for(&mut socket, "session.created").await?;
    send(&mut socket, configuration(sample_rate, vocabulary)).await?;
    // All settings must be accepted before the first PCM frame.
    wait_for(&mut socket, "session.updated").await?;
    output
        .send(json!({ "type": "ready" }))
        .map_err(|_| "DICTATION_CLOSED")?;

    let mut ending = false;
    let mut deadline = Instant::now() + Duration::from_secs(15);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Err("DICTATION_TIMEOUT".into()),
            message = audio.recv(), if !ending => {
                match message {
                    Some(Some(data)) => {
                        send(&mut socket, json!({ "type": "input_audio.append", "audio": data })).await?;
                        // Also closes an abandoned webview's session if PCM stops arriving.
                        deadline = Instant::now() + Duration::from_secs(15);
                    }
                    Some(None) => {
                        send(&mut socket, json!({ "type": "input_audio.end" })).await?;
                        ending = true;
                        deadline = Instant::now() + Duration::from_secs(20);
                    }
                    None => return Err("DICTATION_CLOSED".into()),
                }
            }
            incoming = event(&mut socket) => {
                let value = incoming?;
                match value["type"].as_str() {
                    Some("transcription.text.delta") => {
                        output.send(value).map_err(|_| "DICTATION_CLOSED")?;
                    }
                    Some("transcription.done") if ending => {
                        output.send(value).map_err(|_| "DICTATION_CLOSED")?;
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
}

#[tauri::command]
pub async fn dictation_run(
    state: tauri::State<'_, DictationState>,
    id: String,
    api_key: String,
    sample_rate: u32,
    vocabulary: Vec<String>,
    output: Channel<Value>,
) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || api_key.is_empty()
        || api_key.len() > 2048
        || !(8_000..=96_000).contains(&sample_rate)
        || vocabulary.len() > 100
        || vocabulary.iter().any(|term| term.len() > 1000)
    {
        return Err("DICTATION_INPUT".into());
    }
    let (tx, rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();
    {
        let mut active = state.0.lock().map_err(|_| "DICTATION_STATE")?;
        let mut cancelled = state.1.lock().map_err(|_| "DICTATION_STATE")?;
        if cancelled.as_deref() == Some(id.as_str()) {
            cancelled.take();
            return Err("DICTATION_CANCELLED".into());
        }
        if active.is_some() {
            return Err("DICTATION_BUSY".into());
        }
        *active = Some(Session {
            id: id.clone(),
            audio: tx,
            cancel: cancel.clone(),
        });
    }
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("DICTATION_CANCELLED".into()),
        result = run(api_key, sample_rate, vocabulary, rx, output) => result,
    };
    if let Ok(mut active) = state.0.lock() {
        if active.as_ref().is_some_and(|session| session.id == id) {
            *active = None;
        }
    }
    result
}

#[tauri::command]
pub async fn dictation_audio(
    state: tauri::State<'_, DictationState>,
    id: String,
    data: Option<String>,
) -> Result<(), String> {
    if let Some(value) = &data {
        if value.len() > 65_536 {
            return Err("DICTATION_INPUT".into());
        }
        let pcm = STANDARD.decode(value).map_err(|_| "DICTATION_INPUT")?;
        if pcm.is_empty() || pcm.len() % 2 != 0 {
            return Err("DICTATION_INPUT".into());
        }
    }
    let sender = {
        let active = state.0.lock().map_err(|_| "DICTATION_STATE")?;
        active
            .as_ref()
            .filter(|session| session.id == id)
            .map(|session| session.audio.clone())
            .ok_or("DICTATION_CLOSED")?
    };
    sender
        .send(data)
        .await
        .map_err(|_| "DICTATION_CLOSED".into())
}

#[tauri::command]
pub fn dictation_cancel(state: tauri::State<'_, DictationState>, id: String) {
    if id.is_empty() || id.len() > 64 {
        return;
    }
    if let Ok(active) = state.0.lock() {
        if let Some(session) = active.as_ref().filter(|session| session.id == id) {
            session.cancel.cancel();
        } else if let Ok(mut cancelled) = state.1.lock() {
            // A Cancel invoke may win the race with the async run command.
            // Retain one ID so that run cannot start billing after that click.
            *cancelled = Some(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_sets_pcm_and_phrase_hints_before_audio() {
        let config = configuration(16_000, vec!["Alder Creek Design".into()]);
        assert_eq!(config["session"]["audio_format"]["encoding"], "pcm_s16le");
        assert_eq!(config["session"]["audio_format"]["sample_rate"], 16_000);
        assert_eq!(config["session"]["context_bias"][0], "Alder Creek Design");
        assert!(config["session"].get("language").is_none());
    }

    #[tokio::test]
    async fn websocket_configures_before_audio_and_drains_final_text() {
        use tauri::ipc::InvokeResponseBody;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            socket
                .send(Message::text(
                    json!({"type": "session.created"}).to_string(),
                ))
                .await
                .unwrap();
            let config: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(config["type"], "session.update");
            socket
                .send(Message::text(
                    json!({"type": "session.updated"}).to_string(),
                ))
                .await
                .unwrap();
            let frame: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(frame["type"], "input_audio.append");
            assert_eq!(frame["audio"], "AAAAAA==");
            socket
                .send(Message::text(
                    json!({"type":"transcription.text.delta", "text":"Bonjour"}).to_string(),
                ))
                .await
                .unwrap();
            let end: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(end["type"], "input_audio.end");
            socket
                .send(Message::text(
                    json!({"type":"transcription.text.delta", "text":"."}).to_string(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::text(
                    json!({"type":"transcription.done", "text":"Bonjour."}).to_string(),
                ))
                .await
                .unwrap();
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let (tx, rx) = mpsc::channel(4);
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let collected = events.clone();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Json(text) = body {
                let event: Value = serde_json::from_str(&text).unwrap();
                if event["type"] == "ready" {
                    tx.try_send(Some("AAAAAA==".into())).unwrap();
                    tx.try_send(None).unwrap();
                }
                collected.lock().unwrap().push(event);
            }
            Ok(())
        });
        timeout(
            Duration::from_secs(5),
            stream(socket, 16_000, vec![], rx, output),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|value| value["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "ready",
                "transcription.text.delta",
                "transcription.text.delta",
                "transcription.done"
            ]
        );
        assert_eq!(events.last().unwrap()["text"], "Bonjour.");
    }
}
