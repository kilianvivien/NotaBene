mod compatibility;
mod download;
mod manager;
mod manifest;
mod protocol;
mod worker;

use crate::tts::types::{AudioEvent, EngineState, StreamRequest, Voice};
use tauri::ipc::Channel;
use tauri::AppHandle;

const VOICES: &[(&str, &str)] = &[
    ("casual_male", "en"),
    ("casual_female", "en"),
    ("cheerful_female", "en"),
    ("neutral_male", "en"),
    ("neutral_female", "en"),
    ("fr_male", "fr"),
    ("fr_female", "fr"),
    ("es_male", "es"),
    ("es_female", "es"),
    ("de_male", "de"),
    ("de_female", "de"),
    ("it_male", "it"),
    ("it_female", "it"),
    ("pt_male", "pt"),
    ("pt_female", "pt"),
    ("nl_male", "nl"),
    ("nl_female", "nl"),
    ("ar_male", "ar"),
    ("hi_male", "hi"),
    ("hi_female", "hi"),
];

pub fn status(app: &AppHandle) -> EngineState {
    manager::status(app)
}

pub fn install(app: AppHandle, accepted_license: String) -> Result<(), String> {
    manager::install(app, accepted_license)
}

pub fn cancel_install() {
    manager::cancel_install();
}

pub fn remove(app: &AppHandle) -> Result<(), String> {
    worker::shutdown();
    manager::remove(app)
}

pub fn voices(app: &AppHandle) -> Result<Vec<Voice>, String> {
    if !matches!(
        status(app),
        EngineState::Installed | EngineState::Ready | EngineState::Busy { .. }
    ) {
        return Err("TTS_MODEL_NOT_INSTALLED: install Voxtral first".into());
    }
    Ok(VOICES
        .iter()
        .map(|(id, locale)| Voice {
            id: (*id).into(),
            // The upstream repository documents identifiers, not persona
            // names; showing the stable source id avoids inventing attributes.
            name: (*id).into(),
            locale: (*locale).into(),
            quality: "premium",
        })
        .collect())
}

pub async fn synthesize_stream(
    app: AppHandle,
    request: StreamRequest,
    on_event: Channel<AudioEvent>,
) -> Result<(), String> {
    if request.text.trim().is_empty() || request.text.split_whitespace().count() > 300 {
        return Err("TTS_GENERATION_FAILED: text must contain 1–300 words".into());
    }
    if request
        .playback_rate
        .is_some_and(|rate| !rate.is_finite() || !(0.5..=2.0).contains(&rate))
    {
        return Err("TTS_GENERATION_FAILED: invalid playback rate".into());
    }
    if !VOICES.iter().any(|(id, _)| *id == request.voice_id) {
        return Err("TTS_GENERATION_FAILED: unknown Voxtral voice".into());
    }
    if !matches!(status(&app), EngineState::Installed | EngineState::Ready) {
        return Err("TTS_MODEL_NOT_INSTALLED: install Voxtral first".into());
    }

    let result = worker::synthesize(app, request, on_event).await;
    if let Err(error) = &result {
        if !error.starts_with("TTS_GENERATION_CANCELLED") && !error.starts_with("TTS_BUSY") {
            let code = error
                .split_once(':')
                .map(|(code, _)| code)
                .unwrap_or("TTS_GENERATION_FAILED");
            manager::mark_error(code, error, code != "TTS_WORKER_PROTOCOL");
        }
    }
    result
}

pub fn cancel(request_id: &str) {
    worker::cancel(request_id);
}

pub fn shutdown() {
    worker::shutdown();
}
