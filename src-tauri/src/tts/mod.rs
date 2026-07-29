//! Speech synthesis exposed to the webview.
//!
//! System voices and the optional local Voxtral runtime live here. Hosted TTS
//! APIs are driven from `src/lib/adapters/tts/` over the shared AI transport,
//! so no speech provider host appears in `connect-src`.

mod kokoro;
mod system;
mod voxtral;

use std::sync::atomic::AtomicBool;

pub use kokoro::KokoroManager;
pub use voxtral::VoxtralManager;

pub(super) static LOCAL_SYNTHESIS_BUSY: AtomicBool = AtomicBool::new(false);

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
pub fn tts_voxtral_status(manager: tauri::State<'_, VoxtralManager>) -> voxtral::VoxtralStatus {
    manager.status()
}

#[tauri::command]
pub async fn tts_voxtral_install(
    manager: tauri::State<'_, VoxtralManager>,
    accepted_license: bool,
) -> Result<voxtral::VoxtralStatus, String> {
    manager.install(accepted_license).await
}

#[tauri::command]
pub fn tts_voxtral_cancel_install(manager: tauri::State<'_, VoxtralManager>) -> Result<(), String> {
    manager.cancel_install()
}

#[tauri::command]
pub async fn tts_voxtral_remove(
    manager: tauri::State<'_, VoxtralManager>,
) -> Result<voxtral::VoxtralStatus, String> {
    manager.remove().await
}

#[tauri::command]
pub async fn tts_voxtral_unload(
    manager: tauri::State<'_, VoxtralManager>,
) -> Result<voxtral::VoxtralStatus, String> {
    manager.unload().await
}

#[tauri::command]
pub fn tts_voxtral_voices() -> Vec<voxtral::VoxtralVoice> {
    voxtral::voices()
}

#[tauri::command]
pub async fn tts_voxtral_synthesize(
    manager: tauri::State<'_, VoxtralManager>,
    request: voxtral::VoxtralRequest,
) -> Result<voxtral::VoxtralSegment, String> {
    manager.synthesize(request).await
}

#[tauri::command]
pub fn tts_kokoro_status(manager: tauri::State<'_, KokoroManager>) -> kokoro::KokoroStatus {
    manager.status()
}

#[tauri::command]
pub async fn tts_kokoro_install(
    manager: tauri::State<'_, KokoroManager>,
    accepted_license: bool,
) -> Result<kokoro::KokoroStatus, String> {
    manager.install(accepted_license).await
}

#[tauri::command]
pub fn tts_kokoro_cancel_install(manager: tauri::State<'_, KokoroManager>) -> Result<(), String> {
    manager.cancel_install()
}

#[tauri::command]
pub async fn tts_kokoro_remove(
    manager: tauri::State<'_, KokoroManager>,
) -> Result<kokoro::KokoroStatus, String> {
    manager.remove().await
}

#[tauri::command]
pub async fn tts_kokoro_unload(
    manager: tauri::State<'_, KokoroManager>,
) -> Result<kokoro::KokoroStatus, String> {
    manager.unload().await
}

#[tauri::command]
pub fn tts_kokoro_voices() -> Vec<kokoro::KokoroVoice> {
    kokoro::voices()
}

#[tauri::command]
pub async fn tts_kokoro_synthesize(
    manager: tauri::State<'_, KokoroManager>,
    request: kokoro::KokoroRequest,
) -> Result<kokoro::KokoroSegment, String> {
    manager.synthesize(request).await
}
