//! Local Voxtral TTS behind a NotaBene-owned boundary.
//!
//! CrispASR is deliberately mentioned in this file and nowhere else in the
//! application runtime. A dedicated thread owns its session for its full
//! lifetime, so neither Tokio nor Tauri ever moves the C++/Metal context
//! between worker threads.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

use super::LOCAL_SYNTHESIS_BUSY;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crispasr::Session;

const INSTALL_EVENT: &str = "notabene-voxtral-install-progress";
const ACTIVATION_FILE: &str = "activation.json";
const PARTIAL_SUFFIX: &str = ".partial";
pub(super) const SAMPLE_RATE_HZ: u32 = 24_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const MAX_TEXT_CHARS: usize = 1_200;
// 30.7 seconds at Voxtral's 12.5 Hz semantic frame rate. App-side chunks are
// deliberately much shorter; this is a native last line of defence against a
// missing END_AUDIO token and must be applied before every session is reused.
const MAX_GENERATED_FRAMES: i32 = 384;
// Reset flow-matching noise before each independent chunk so the same preset
// voice does not drift as the session RNG advances. Seed 42 reads the short
// French regression title completely; seed 1 is reserved for one bounded
// recovery attempt when a short utterance terminates implausibly early.
const STABLE_ACOUSTIC_SEED: u64 = 42;
const RECOVERY_ACOUSTIC_SEED: u64 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ModelManifest {
    runtime_tag: String,
    runtime_commit: String,
    ggml_commit: String,
    repository: String,
    revision: String,
    filename: String,
    url: String,
    size: u64,
    sha256: String,
    license: String,
    license_url: String,
    upstream_model: String,
    sample_rate_hz: u32,
    channels: u16,
    minimum_free_bytes: u64,
}

fn manifest() -> &'static ModelManifest {
    static MANIFEST: std::sync::OnceLock<ModelManifest> = std::sync::OnceLock::new();
    MANIFEST.get_or_init(|| {
        let parsed: ModelManifest =
            serde_json::from_str(include_str!("../../resources/voxtral-model-manifest.json"))
                .expect("the bundled Voxtral manifest must be valid JSON");
        assert_eq!(parsed.sample_rate_hz, SAMPLE_RATE_HZ);
        assert_eq!(parsed.channels, CHANNELS);
        parsed
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoxtralStatusKind {
    Unsupported,
    NotInstalled,
    Downloading,
    Verifying,
    Ready,
    Loading,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxtralStatus {
    kind: VoxtralStatusKind,
    supported: bool,
    model_revision: String,
    model_size_bytes: u64,
    downloaded_bytes: u64,
    total_bytes: u64,
    loaded: bool,
    error_code: Option<String>,
    message: Option<String>,
}

impl VoxtralStatus {
    fn new(kind: VoxtralStatusKind) -> Self {
        let model = manifest();
        Self {
            kind,
            supported: compatible_platform(),
            model_revision: model.revision.clone(),
            model_size_bytes: model.size,
            downloaded_bytes: 0,
            total_bytes: model.size,
            loaded: false,
            error_code: None,
            message: None,
        }
    }

    fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        let mut status = Self::new(VoxtralStatusKind::Error);
        status.error_code = Some(code.into());
        status.message = Some(message.into());
        status
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxtralVoice {
    id: &'static str,
    name: &'static str,
    locale: &'static str,
    quality: &'static str,
}

const VOICE_IDS: &[&str] = &[
    "casual_female",
    "casual_male",
    "cheerful_female",
    "neutral_female",
    "neutral_male",
    "fr_female",
    "fr_male",
];

pub fn voices() -> Vec<VoxtralVoice> {
    vec![
        VoxtralVoice {
            id: "casual_female",
            name: "Casual female",
            locale: "en",
            quality: "premium",
        },
        VoxtralVoice {
            id: "casual_male",
            name: "Casual male",
            locale: "en",
            quality: "premium",
        },
        VoxtralVoice {
            id: "cheerful_female",
            name: "Cheerful female",
            locale: "en",
            quality: "premium",
        },
        VoxtralVoice {
            id: "neutral_female",
            name: "Neutral female",
            locale: "en",
            quality: "premium",
        },
        VoxtralVoice {
            id: "neutral_male",
            name: "Neutral male",
            locale: "en",
            quality: "premium",
        },
        VoxtralVoice {
            id: "fr_female",
            name: "French female",
            locale: "fr",
            quality: "premium",
        },
        VoxtralVoice {
            id: "fr_male",
            name: "French male",
            locale: "fr",
            quality: "premium",
        },
    ]
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxtralRequest {
    text: String,
    voice_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoxtralSegment {
    data: String,
    mime: &'static str,
    duration_ms: u64,
    sample_rate_hz: u32,
    channels: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationRecord {
    revision: String,
    sha256: String,
    size: u64,
    accepted_license: String,
    accepted_at: String,
}

enum WorkerRequest {
    Synthesize {
        model_path: PathBuf,
        text: String,
        voice: String,
        reply: oneshot::Sender<Result<Vec<f32>, String>>,
    },
    Unload {
        reply: oneshot::Sender<Result<(), String>>,
    },
}

pub struct VoxtralManager {
    app: AppHandle,
    model_dir: PathBuf,
    worker: mpsc::SyncSender<WorkerRequest>,
    status: Arc<Mutex<VoxtralStatus>>,
    installing: AtomicBool,
    cancel_install_requested: AtomicBool,
    loaded: AtomicBool,
}

impl VoxtralManager {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let model = manifest();
        let model_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("models")
            .join("voxtral-4b-tts")
            .join(&model.revision);
        let initial = inspect_installation(&model_dir);
        let (worker, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("notabene-voxtral".into())
            .spawn(move || worker_loop(receiver))
            .map_err(|error| format!("TTS_NATIVE_RUNTIME_MISSING: {error}"))?;

        let manager = Self {
            app: app.clone(),
            model_dir,
            worker,
            status: Arc::new(Mutex::new(initial)),
            installing: AtomicBool::new(false),
            cancel_install_requested: AtomicBool::new(false),
            loaded: AtomicBool::new(false),
        };

        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        if !Session::available_backends()
            .iter()
            .any(|backend| backend == "voxtral-tts")
        {
            manager.replace_status(VoxtralStatus::error(
                "TTS_NATIVE_RUNTIME_MISSING",
                "The bundled local speech runtime is unavailable. Reinstall NotaBene.",
            ));
        }

        Ok(manager)
    }

    pub fn status(&self) -> VoxtralStatus {
        self.status_lock().clone()
    }

    pub async fn install(&self, accepted_license: bool) -> Result<VoxtralStatus, String> {
        require_supported()?;
        if !accepted_license {
            return Err(
                "TTS_LICENSE_NOT_ACCEPTED: Accept the model license before installing.".into(),
            );
        }
        if self
            .installing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("TTS_BUSY: A model installation is already running.".into());
        }
        let _installing = AtomicReset(&self.installing);
        if LOCAL_SYNTHESIS_BUSY.load(Ordering::Acquire) {
            return Err("TTS_BUSY: Speech synthesis is currently running.".into());
        }
        self.cancel_install_requested
            .store(false, Ordering::Release);

        match self.install_inner().await {
            Ok(status) => Ok(status),
            Err(error) => {
                let (code, message) = split_error(&error);
                let status = if code == "TTS_CANCELLED" {
                    let mut status = VoxtralStatus::new(VoxtralStatusKind::NotInstalled);
                    status.error_code = Some(code.into());
                    status.message = Some(message.into());
                    status
                } else {
                    VoxtralStatus::error(code, message)
                };
                self.replace_status(status);
                self.publish_status();
                Err(error)
            }
        }
    }

    async fn install_inner(&self) -> Result<VoxtralStatus, String> {
        let model = manifest();
        tokio::fs::create_dir_all(&self.model_dir)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not create the model folder.")?;

        let free = fs2::available_space(&self.model_dir)
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not check available disk space.")?;
        if free < model.minimum_free_bytes {
            return Err("TTS_MODEL_INCOMPLETE: At least 4.7 GB of free space is required.".into());
        }

        let final_path = self.model_path();
        let model_partial = partial_path(&final_path);
        let activation_path = self.model_dir.join(ACTIVATION_FILE);
        let activation_partial = partial_path(&activation_path);
        for path in [
            &model_partial,
            &activation_partial,
            &final_path,
            &activation_path,
        ] {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(
                        "TTS_MODEL_INCOMPLETE: Could not replace the previous download.".into(),
                    )
                }
            }
        }

        self.update_progress(VoxtralStatusKind::Downloading, 0);
        let response = reqwest::Client::builder()
            .build()
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not start the download.")?
            .get(&model.url)
            .send()
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: The model download failed.")?
            .error_for_status()
            .map_err(|_| "TTS_MODEL_INCOMPLETE: The model download failed.")?;
        if response.content_length() != Some(model.size) {
            return Err(
                "TTS_MODEL_INCOMPLETE: The server reported an unexpected model size.".into(),
            );
        }

        let mut file = tokio::fs::File::create(&model_partial)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not create the model file.")?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0u64;
        let mut hasher = Sha256::new();
        let mut last_event = Instant::now();
        while let Some(next) = stream.next().await {
            if self.cancel_install_requested.load(Ordering::Acquire) {
                drop(file);
                let _ = tokio::fs::remove_file(&model_partial).await;
                return Err("TTS_CANCELLED: Model installation was cancelled.".into());
            }
            let chunk =
                next.map_err(|_| "TTS_MODEL_INCOMPLETE: The model download was interrupted.")?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > model.size {
                return Err("TTS_MODEL_INCOMPLETE: The model file is too large.".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not write the model file.")?;
            if last_event.elapsed() >= Duration::from_millis(200) {
                self.update_progress(VoxtralStatusKind::Downloading, downloaded);
                last_event = Instant::now();
            }
        }
        file.flush()
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not finish the model file.")?;
        file.sync_all()
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not finish the model file.")?;
        drop(file);

        self.update_progress(VoxtralStatusKind::Verifying, downloaded);
        if downloaded != model.size {
            let _ = tokio::fs::remove_file(&model_partial).await;
            return Err("TTS_MODEL_INCOMPLETE: The model download is incomplete.".into());
        }
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != model.sha256 {
            let _ = tokio::fs::remove_file(&model_partial).await;
            return Err("TTS_MODEL_INCOMPLETE: The model checksum did not match.".into());
        }

        tokio::fs::rename(&model_partial, &final_path)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not activate the model file.")?;
        let activation = ActivationRecord {
            revision: model.revision.clone(),
            sha256: model.sha256.clone(),
            size: model.size,
            accepted_license: model.license.clone(),
            accepted_at: chrono::Utc::now().to_rfc3339(),
        };
        let activation_bytes = serde_json::to_vec_pretty(&activation)
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not record model activation.")?;
        tokio::fs::write(&activation_partial, activation_bytes)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not record model activation.")?;
        tokio::fs::rename(&activation_partial, &activation_path)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not activate the model.")?;

        let status = VoxtralStatus::new(VoxtralStatusKind::Ready);
        self.replace_status(status.clone());
        self.publish_status();
        Ok(status)
    }

    pub fn cancel_install(&self) -> Result<(), String> {
        if !self.installing.load(Ordering::Acquire) {
            return Err("TTS_CANCELLED: No model installation is running.".into());
        }
        self.cancel_install_requested.store(true, Ordering::Release);
        Ok(())
    }

    pub async fn synthesize(&self, request: VoxtralRequest) -> Result<VoxtralSegment, String> {
        require_supported()?;
        let text = request.text.trim();
        if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
            return Err(
                "TTS_GENERATION_FAILED: Speech chunks must contain 1–1,200 characters.".into(),
            );
        }
        if !VOICE_IDS.contains(&request.voice_id.as_str()) {
            return Err("TTS_GENERATION_FAILED: Unknown Voxtral preset voice.".into());
        }
        if inspect_installation(&self.model_dir).kind != VoxtralStatusKind::Ready {
            return Err("TTS_MODEL_NOT_INSTALLED: Install local Voxtral first.".into());
        }
        if LOCAL_SYNTHESIS_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("TTS_BUSY: Another speech segment is being generated.".into());
        }
        let _synthesizing = AtomicReset(&LOCAL_SYNTHESIS_BUSY);

        if !self.loaded.load(Ordering::Acquire) {
            let mut status = VoxtralStatus::new(VoxtralStatusKind::Loading);
            status.downloaded_bytes = manifest().size;
            self.replace_status(status);
            self.publish_status();
        }

        let (reply, receive) = oneshot::channel();
        self.worker
            .try_send(WorkerRequest::Synthesize {
                model_path: self.model_path(),
                text: text.to_string(),
                voice: request.voice_id,
                reply,
            })
            .map_err(|_| "TTS_BUSY: The local speech worker is busy.")?;
        let pcm = receive
            .await
            .map_err(|_| "TTS_GENERATION_FAILED: The local speech worker stopped.")??;
        let wav = encode_pcm_wav(&pcm)?;
        self.loaded.store(true, Ordering::Release);
        let mut status = VoxtralStatus::new(VoxtralStatusKind::Ready);
        status.downloaded_bytes = manifest().size;
        status.loaded = true;
        self.replace_status(status);
        self.publish_status();

        Ok(VoxtralSegment {
            data: base64::engine::general_purpose::STANDARD.encode(&wav),
            mime: "audio/wav",
            duration_ms: (pcm.len() as u64 * 1000) / SAMPLE_RATE_HZ as u64,
            sample_rate_hz: SAMPLE_RATE_HZ,
            channels: CHANNELS,
        })
    }

    pub async fn unload(&self) -> Result<VoxtralStatus, String> {
        if LOCAL_SYNTHESIS_BUSY.load(Ordering::Acquire) {
            return Err("TTS_BUSY: Speech synthesis is currently running.".into());
        }
        let (reply, receive) = oneshot::channel();
        self.worker
            .try_send(WorkerRequest::Unload { reply })
            .map_err(|_| "TTS_BUSY: The local speech worker is busy.")?;
        receive
            .await
            .map_err(|_| "TTS_GENERATION_FAILED: The local speech worker stopped.")??;
        self.loaded.store(false, Ordering::Release);
        let mut status = inspect_installation(&self.model_dir);
        status.loaded = false;
        self.replace_status(status.clone());
        self.publish_status();
        Ok(status)
    }

    pub async fn remove(&self) -> Result<VoxtralStatus, String> {
        if self.installing.load(Ordering::Acquire) {
            return Err("TTS_BUSY: Cancel the model installation before removing it.".into());
        }
        self.unload().await?;
        match tokio::fs::remove_dir_all(&self.model_dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("TTS_MODEL_INCOMPLETE: Could not remove the model.".into()),
        }
        let status = VoxtralStatus::new(VoxtralStatusKind::NotInstalled);
        self.replace_status(status.clone());
        self.publish_status();
        Ok(status)
    }

    fn model_path(&self) -> PathBuf {
        self.model_dir.join(&manifest().filename)
    }

    fn update_progress(&self, kind: VoxtralStatusKind, downloaded: u64) {
        let mut status = VoxtralStatus::new(kind);
        status.downloaded_bytes = downloaded;
        self.replace_status(status);
        self.publish_status();
    }

    fn publish_status(&self) {
        let _ = self.app.emit(INSTALL_EVENT, self.status());
    }

    fn replace_status(&self, status: VoxtralStatus) {
        *self.status_lock() = status;
    }

    fn status_lock(&self) -> std::sync::MutexGuard<'_, VoxtralStatus> {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct AtomicReset<'a>(&'a AtomicBool);

impl Drop for AtomicReset<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn compatible_platform() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

fn require_supported() -> Result<(), String> {
    if compatible_platform() {
        Ok(())
    } else {
        Err("TTS_VOXTRAL_UNSUPPORTED: Local Voxtral requires an Apple Silicon Mac.".into())
    }
}

fn inspect_installation(model_dir: &Path) -> VoxtralStatus {
    if !compatible_platform() {
        let mut status = VoxtralStatus::new(VoxtralStatusKind::Unsupported);
        status.error_code = Some("TTS_VOXTRAL_UNSUPPORTED".into());
        status.message = Some("Local Voxtral requires an Apple Silicon Mac.".into());
        return status;
    }
    let model = manifest();
    let final_path = model_dir.join(&model.filename);
    let partial = partial_path(&final_path);
    if partial.exists() {
        let mut status = VoxtralStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "An incomplete model download must be retried.",
        );
        status.downloaded_bytes = std::fs::metadata(partial).map(|m| m.len()).unwrap_or(0);
        return status;
    }
    let Ok(metadata) = std::fs::metadata(&final_path) else {
        return VoxtralStatus::new(VoxtralStatusKind::NotInstalled);
    };
    if metadata.len() != model.size {
        return VoxtralStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The installed model has an unexpected size.",
        );
    }
    let activation_path = model_dir.join(ACTIVATION_FILE);
    let Ok(mut activation_file) = std::fs::File::open(activation_path) else {
        return VoxtralStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The installed model has no valid activation record.",
        );
    };
    let mut contents = String::new();
    if activation_file.read_to_string(&mut contents).is_err() {
        return VoxtralStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The model activation record could not be read.",
        );
    }
    let Ok(activation) = serde_json::from_str::<ActivationRecord>(&contents) else {
        return VoxtralStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The model activation record is invalid.",
        );
    };
    if activation.revision != model.revision
        || activation.sha256 != model.sha256
        || activation.size != model.size
        || activation.accepted_license != model.license
    {
        return VoxtralStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The model activation record does not match this app version.",
        );
    }
    let mut status = VoxtralStatus::new(VoxtralStatusKind::Ready);
    status.downloaded_bytes = model.size;
    status
}

fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(PARTIAL_SUFFIX);
    PathBuf::from(name)
}

fn split_error(error: &str) -> (&str, &str) {
    error
        .split_once(':')
        .map(|(code, message)| (code.trim(), message.trim()))
        .unwrap_or(("TTS_GENERATION_FAILED", "Local speech failed."))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn short_pcm_is_incomplete(text: &str, sample_count: usize) -> bool {
    if text.chars().count() > 80 {
        return false;
    }
    let words = text
        .split_whitespace()
        .filter(|word| word.chars().any(char::is_alphabetic))
        .count();
    let minimum_samples = words * SAMPLE_RATE_HZ as usize * 140 / 1_000;
    words >= 3 && sample_count < minimum_samples
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn worker_loop(receiver: mpsc::Receiver<WorkerRequest>) {
    let mut open: Option<(PathBuf, Session)> = None;
    while let Ok(request) = receiver.recv() {
        match request {
            WorkerRequest::Synthesize {
                model_path,
                text,
                voice,
                reply,
            } => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if open
                        .as_ref()
                        .is_none_or(|(loaded_path, _)| loaded_path != &model_path)
                    {
                        let threads = std::thread::available_parallelism()
                            .map(|value| value.get().clamp(2, 8) as i32)
                            .unwrap_or(4);
                        let session = Session::open_with_backend(
                            model_path.to_string_lossy().as_ref(),
                            "voxtral-tts",
                            threads,
                        )
                        .map_err(|detail| {
                            eprintln!("Voxtral model load failed: {detail}");
                            "TTS_MODEL_LOAD_FAILED: The local model could not be loaded."
                                .to_string()
                        })?;
                        session
                            .set_max_new_tokens(MAX_GENERATED_FRAMES)
                            .map_err(|detail| {
                                eprintln!("Voxtral generation limit setup failed: {detail}");
                                "TTS_MODEL_LOAD_FAILED: The local model safety limit could not be configured."
                                    .to_string()
                            })?;
                        open = Some((model_path.clone(), session));
                    }
                    let session = &open.as_ref().expect("session was opened").1;
                    session.set_voice(&voice, None).map_err(|detail| {
                        eprintln!("Voxtral voice selection failed: {detail}");
                        "TTS_GENERATION_FAILED: The preset voice could not be selected.".to_string()
                    })?;
                    session
                        .set_tts_seed(STABLE_ACOUSTIC_SEED)
                        .map_err(|detail| {
                            eprintln!("Voxtral acoustic seed setup failed: {detail}");
                            "TTS_GENERATION_FAILED: The preset voice could not be stabilized."
                                .to_string()
                        })?;
                    let mut pcm = session.synthesize(&text).map_err(|detail| {
                        eprintln!("Voxtral synthesis failed: {detail}");
                        "TTS_GENERATION_FAILED: Local speech generation failed.".to_string()
                    })?;
                    if short_pcm_is_incomplete(&text, pcm.len()) {
                        session
                            .set_tts_seed(RECOVERY_ACOUSTIC_SEED)
                            .map_err(|detail| {
                                eprintln!("Voxtral recovery seed setup failed: {detail}");
                                "TTS_GENERATION_FAILED: Local speech recovery could not start."
                                    .to_string()
                            })?;
                        let recovered = session.synthesize(&text).map_err(|detail| {
                            eprintln!("Voxtral recovery synthesis failed: {detail}");
                            "TTS_GENERATION_FAILED: Local speech recovery failed.".to_string()
                        })?;
                        if recovered.len() > pcm.len() {
                            pcm = recovered;
                        }
                    }
                    Ok(pcm)
                }))
                .unwrap_or_else(|_| {
                    Err(
                        "TTS_GENERATION_FAILED: The local speech runtime stopped unexpectedly."
                            .into(),
                    )
                });
                let _ = reply.send(result);
            }
            WorkerRequest::Unload { reply } => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    open = None;
                }))
                .map_err(|_| {
                    "TTS_GENERATION_FAILED: The local model could not be unloaded.".to_string()
                });
                let _ = reply.send(result);
            }
        }
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn worker_loop(receiver: mpsc::Receiver<WorkerRequest>) {
    while let Ok(request) = receiver.recv() {
        match request {
            WorkerRequest::Synthesize { reply, .. } => {
                let _ = reply.send(Err(
                    "TTS_VOXTRAL_UNSUPPORTED: Local Voxtral requires Apple Silicon.".into(),
                ));
            }
            WorkerRequest::Unload { reply } => {
                let _ = reply.send(Ok(()));
            }
        }
    }
}

pub(super) fn encode_pcm_wav(pcm: &[f32]) -> Result<Vec<u8>, String> {
    if pcm.is_empty() {
        return Err("TTS_AUDIO_INVALID: The local model returned no audio.".into());
    }
    if pcm.iter().any(|sample| !sample.is_finite()) {
        return Err("TTS_AUDIO_INVALID: The local model returned invalid audio.".into());
    }
    let data_len = pcm
        .len()
        .checked_mul(2)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| "TTS_AUDIO_INVALID: The generated audio is too large.".to_string())?;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36u32 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE_HZ * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in pcm {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = if clamped >= 0.0 {
            (clamped * i16::MAX as f32).round() as i16
        } else {
            (clamped * -(i16::MIN as f32)).round() as i16
        };
        wav.extend_from_slice(&value.to_le_bytes());
    }
    Ok(wav)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_valid_24_khz_mono_pcm() {
        let wav = encode_pcm_wav(&[-1.5, -0.5, 0.0, 0.5, 1.5]).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            24_000
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(wav.len(), 54);
    }

    #[test]
    fn rejects_non_finite_pcm() {
        assert!(encode_pcm_wav(&[f32::NAN])
            .unwrap_err()
            .contains("TTS_AUDIO_INVALID"));
        assert!(encode_pcm_wav(&[f32::INFINITY])
            .unwrap_err()
            .contains("TTS_AUDIO_INVALID"));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn detects_an_implausibly_short_native_utterance() {
        assert!(short_pcm_is_incomplete(
            "Nette baisse des températures jeudi.",
            SAMPLE_RATE_HZ as usize / 2,
        ));
        assert!(!short_pcm_is_incomplete(
            "Nette baisse des températures jeudi.",
            SAMPLE_RATE_HZ as usize * 3,
        ));
        assert!(!short_pcm_is_incomplete(
            &"mot ".repeat(40),
            SAMPLE_RATE_HZ as usize / 2,
        ));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires NOTABENE_VOXTRAL_MODEL to point at the pinned Q4_K GGUF"]
    fn binding_smoke_reuses_one_session() {
        let path = std::env::var("NOTABENE_VOXTRAL_MODEL")
            .expect("set NOTABENE_VOXTRAL_MODEL to the pinned Q4_K GGUF");
        let load_started = Instant::now();
        let session = Session::open_with_backend(&path, "voxtral-tts", 4).unwrap();
        session.set_max_new_tokens(MAX_GENERATED_FRAMES).unwrap();
        let load_time = load_started.elapsed();
        session.set_voice("neutral_female", None).unwrap();
        let english_started = Instant::now();
        let english = session.synthesize("A short local speech test.").unwrap();
        let english_time = english_started.elapsed();
        assert!(encode_pcm_wav(&english).unwrap().len() > 44);
        session.set_voice("fr_female", None).unwrap();
        let french_started = Instant::now();
        let french = session
            .synthesize("Un court test de synthèse vocale locale.")
            .unwrap();
        let french_time = french_started.elapsed();
        assert!(encode_pcm_wav(&french).unwrap().len() > 44);
        session.set_voice("neutral_female", None).unwrap();
        let long_started = Instant::now();
        let long = session
            .synthesize(
                "This longer passage verifies that Voxtral can read a realistic note chunk completely, while its codec stays within a fixed memory budget on a sixteen gigabyte Mac.",
            )
            .unwrap();
        let long_time = long_started.elapsed();
        assert!(
            long.len() >= SAMPLE_RATE_HZ as usize * 3,
            "the realistic chunk was implausibly short"
        );
        assert!(encode_pcm_wav(&long).unwrap().len() > 44);
        eprintln!(
            "load={load_time:?} en={english_time:?}/{} samples fr={french_time:?}/{} samples long={long_time:?}/{} samples",
            english.len(),
            french.len(),
            long.len()
        );
        drop(session);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires NOTABENE_VOXTRAL_MODEL and optionally NOTABENE_VOXTRAL_OUTPUT"]
    fn binding_reproduces_french_note_then_podcast() {
        let path = std::env::var("NOTABENE_VOXTRAL_MODEL")
            .expect("set NOTABENE_VOXTRAL_MODEL to the pinned Q4_K GGUF");
        let output = std::env::var_os("NOTABENE_VOXTRAL_OUTPUT").map(PathBuf::from);
        if let Some(output) = &output {
            std::fs::create_dir_all(output).unwrap();
        }

        let session = Session::open_with_backend(&path, "voxtral-tts", 4).unwrap();
        session.set_max_new_tokens(MAX_GENERATED_FRAMES).unwrap();
        session.set_voice("fr_female", None).unwrap();
        let chunks = [
            "Nette baisse des températures jeudi. Sur l’Aquitaine, les maximales seront souvent comprises entre 38 et 41 degrés Celsius. Localement, des températures de 42 degrés Celsius sont possibles sur l’intérieur de la Gironde et des Landes.",
            "Il est prévu que ces deux départements repassent au niveau jaune jeudi à 6 heures à la faveur d’une nette baisse des températures. Sur le centre-est du pays, les très fortes chaleurs seront durables. Un nouvel épisode caniculaire va y débuter.",
            "Mercredi, les maximales y seront comprises entre 36 et 39 degrés Celsius. Sur le reste du pays les maximales seront souvent comprises entre 35 et 38 degrés Celsius. Jeudi une nette baisse des températures est attendue sur une large moitié ouest du pays.",
            "Et il pensait que c’était la vérité vraie ! Source, Le Monde.",
            "Bienvenue dans cet épisode consacré à la canicule. Nous allons reprendre les informations essentielles de la note, sans oublier les températures ni les régions concernées.",
            "En Aquitaine, les maximales seront comprises entre 38 et 41 degrés Celsius. Dans certaines zones de la Gironde et des Landes, elles pourront atteindre 42 degrés. Jeudi, une baisse nette des températures est attendue dans l’ouest du pays.",
            "Le centre-est conservera néanmoins des chaleurs très fortes et durables.",
            "AI tools stay in a connect-a-provider state until you choose a provider in Settings. No note is sent anywhere before that. Note written on the 29th of July 2026.",
        ];

        for (index, text) in chunks.iter().enumerate() {
            let started = Instant::now();
            session.set_tts_seed(STABLE_ACOUSTIC_SEED).unwrap();
            let mut pcm = session
                .synthesize(text)
                .unwrap_or_else(|error| panic!("chunk {} failed: {error}", index + 1));
            let words = text.split_whitespace().count();
            let minimum_samples = words * SAMPLE_RATE_HZ as usize * 140 / 1_000;
            if words >= 3 && pcm.len() < minimum_samples {
                eprintln!(
                    "chunk={} retrying implausibly short {:.2}s result",
                    index + 1,
                    pcm.len() as f64 / SAMPLE_RATE_HZ as f64
                );
                session.set_tts_seed(RECOVERY_ACOUSTIC_SEED).unwrap();
                pcm = session
                    .synthesize(text)
                    .unwrap_or_else(|error| panic!("chunk {} retry failed: {error}", index + 1));
            }
            assert!(
                words < 3 || pcm.len() >= minimum_samples,
                "chunk {} was implausibly short twice",
                index + 1,
            );
            if let Some(output) = &output {
                std::fs::write(
                    output.join(format!("{:02}.wav", index + 1)),
                    encode_pcm_wav(&pcm).unwrap(),
                )
                .unwrap();
                std::fs::write(output.join(format!("{:02}.txt", index + 1)), text).unwrap();
            }
            eprintln!(
                "chunk={} chars={} duration={:.2}s elapsed={:?}",
                index + 1,
                text.chars().count(),
                pcm.len() as f64 / SAMPLE_RATE_HZ as f64,
                started.elapsed()
            );
        }
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires NOTABENE_VOXTRAL_MODEL and NOTABENE_VOXTRAL_TEXT"]
    fn binding_synthesizes_one_diagnostic_prompt() {
        let path = std::env::var("NOTABENE_VOXTRAL_MODEL")
            .expect("set NOTABENE_VOXTRAL_MODEL to the pinned Q4_K GGUF");
        let text = std::env::var("NOTABENE_VOXTRAL_TEXT").expect("set NOTABENE_VOXTRAL_TEXT");
        let voice = std::env::var("NOTABENE_VOXTRAL_VOICE").unwrap_or_else(|_| "fr_female".into());
        let session = Session::open_with_backend(&path, "voxtral-tts", 4).unwrap();
        session.set_max_new_tokens(MAX_GENERATED_FRAMES).unwrap();
        session.set_voice(&voice, None).unwrap();
        if let Ok(seed) = std::env::var("NOTABENE_VOXTRAL_SEED") {
            session
                .set_tts_seed(seed.parse().expect("seed must be u64"))
                .unwrap();
        }
        let pcm = session.synthesize(&text).unwrap();
        assert!(pcm.len() >= SAMPLE_RATE_HZ as usize);
        if let Some(output) = std::env::var_os("NOTABENE_VOXTRAL_OUTPUT") {
            std::fs::write(output, encode_pcm_wav(&pcm).unwrap()).unwrap();
        }
        eprintln!(
            "chars={} duration={:.2}s",
            text.chars().count(),
            pcm.len() as f64 / SAMPLE_RATE_HZ as f64
        );
    }

    #[test]
    fn manifest_is_the_pinned_q4_k_model() {
        let model = manifest();
        assert_eq!(model.filename, "voxtral-4b-tts-q4_k.gguf");
        assert_eq!(model.size, 2_353_230_080);
        assert_eq!(
            model.sha256,
            "8cde56a6506dd78bf143352e96502e76d951ce506e9dfbeec92666c16bbed53b"
        );
        assert_eq!(model.runtime_tag, "v0.8.23");
        assert!(!model.runtime_commit.is_empty());
        assert!(!model.ggml_commit.is_empty());
        assert_eq!(model.repository, "cstr/voxtral-4b-tts-GGUF");
        assert_eq!(
            model.license_url,
            "https://creativecommons.org/licenses/by-nc/4.0/"
        );
        assert_eq!(model.upstream_model, "mistralai/Voxtral-4B-TTS-2603");
    }
}
