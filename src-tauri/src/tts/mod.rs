//! Speech synthesis exposed to the webview.
//!
//! macOS system voices are the only engine with a Rust half. The hosted
//! Hosted TTS APIs are driven entirely from `src/lib/adapters/tts/`, over the
//! shared AI transport, so no speech provider host appears in `connect-src`.

mod system;

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
