mod system;
mod types;
mod voxtral;

use types::{AudioEvent, EngineState, EngineSummary, StreamRequest, Voice};

#[tauri::command]
pub async fn tts_system_available() -> bool {
    system::available().await
}

#[tauri::command]
pub async fn tts_system_voices() -> Result<Vec<system::TtsVoice>, String> {
    system::voices().await
}

#[tauri::command]
pub async fn tts_system_synthesize(
    request: system::TtsRequest,
) -> Result<system::TtsSegment, String> {
    system::synthesize_segment(request).await
}

#[tauri::command]
pub async fn tts_engines() -> Vec<EngineSummary> {
    vec![
        EngineSummary {
            id: "system",
            local: true,
            streaming: false,
            sample_rate_hz: Some(22_050),
        },
        EngineSummary {
            id: "voxtral-local",
            local: true,
            streaming: true,
            sample_rate_hz: Some(24_000),
        },
    ]
}

#[tauri::command]
pub async fn tts_engine_status(
    app: tauri::AppHandle,
    engine_id: String,
) -> Result<EngineState, String> {
    match engine_id.as_str() {
        "system" => Ok(if tts_system_available().await {
            EngineState::Ready
        } else {
            EngineState::Unsupported {
                reason: "System speech is unavailable.".into(),
                code: Some("TTS_UNSUPPORTED_OS".into()),
            }
        }),
        "voxtral-local" => Ok(voxtral::status(&app)),
        _ => Err("unknown TTS engine".into()),
    }
}

#[tauri::command]
pub async fn tts_model_install(
    app: tauri::AppHandle,
    accepted_license: String,
) -> Result<(), String> {
    voxtral::install(app, accepted_license)
}

#[tauri::command]
pub async fn tts_model_cancel_install() {
    voxtral::cancel_install();
}

#[tauri::command]
pub async fn tts_model_remove(app: tauri::AppHandle) -> Result<(), String> {
    voxtral::remove(&app)
}

#[tauri::command]
pub async fn tts_voices(app: tauri::AppHandle, engine_id: String) -> Result<Vec<Voice>, String> {
    match engine_id.as_str() {
        "voxtral-local" => voxtral::voices(&app),
        _ => Err("use tts_system_voices for system voices".into()),
    }
}

#[tauri::command]
pub async fn tts_synthesize_stream(
    app: tauri::AppHandle,
    request: StreamRequest,
    on_event: tauri::ipc::Channel<AudioEvent>,
) -> Result<(), String> {
    voxtral::synthesize_stream(app, request, on_event).await
}

#[tauri::command]
pub async fn tts_cancel(request_id: String) {
    voxtral::cancel(&request_id);
}

#[tauri::command]
pub async fn tts_worker_shutdown() {
    voxtral::shutdown();
}
