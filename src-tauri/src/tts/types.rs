use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    tag = "kind",
    rename_all_fields = "camelCase"
)]
pub enum EngineState {
    #[serde(rename = "unsupported")]
    Unsupported {
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename = "not_installed")]
    NotInstalled,
    #[serde(rename = "downloading")]
    Downloading {
        downloaded_bytes: u64,
        total_bytes: u64,
    },
    #[serde(rename = "verifying")]
    Verifying,
    #[serde(rename = "installed")]
    Installed,
    #[serde(rename = "loading")]
    Loading,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "busy")]
    Busy { job_id: String },
    #[serde(rename = "error")]
    Error {
        code: String,
        recoverable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSummary {
    pub id: &'static str,
    pub local: bool,
    pub streaming: bool,
    pub sample_rate_hz: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub quality: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    pub text: String,
    pub voice_id: String,
    pub playback_rate: Option<f32>,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AudioEvent {
    #[serde(rename = "started")]
    Started {
        request_id: String,
        sample_rate_hz: u32,
        channels: u8,
        encoding: &'static str,
    },
    #[serde(rename = "audio")]
    Audio {
        request_id: String,
        sequence: u64,
        data_base64: String,
        sample_count: u64,
    },
    #[serde(rename = "progress")]
    Progress {
        request_id: String,
        generated_samples: u64,
    },
    #[serde(rename = "done")]
    Done {
        request_id: String,
        total_samples: u64,
        duration_ms: u64,
    },
    #[serde(rename = "error")]
    Error {
        request_id: String,
        code: String,
        message: String,
        recoverable: bool,
    },
}
