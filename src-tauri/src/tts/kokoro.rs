//! Managed Kokoro 82M TTS using the same pinned CrispASR runtime as Voxtral.

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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crispasr::Session;

use super::voxtral::{encode_pcm_wav, SAMPLE_RATE_HZ};
use super::{number_words::expand_numbers, LOCAL_SYNTHESIS_BUSY};

const INSTALL_EVENT: &str = "notabene-kokoro-install-progress";
const ACTIVATION_FILE: &str = "activation.json";
const MAX_TEXT_CHARS: usize = 1_200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct KokoroManifest {
    runtime_tag: String,
    runtime_commit: String,
    ggml_commit: String,
    repository: String,
    revision: String,
    license: String,
    license_url: String,
    upstream_model: String,
    sample_rate_hz: u32,
    channels: u16,
    minimum_free_bytes: u64,
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    role: String,
    repository: Option<String>,
    revision: Option<String>,
    filename: String,
    url: String,
    size: u64,
    sha256: String,
}

fn manifest() -> &'static KokoroManifest {
    static MANIFEST: std::sync::OnceLock<KokoroManifest> = std::sync::OnceLock::new();
    MANIFEST.get_or_init(|| {
        let parsed: KokoroManifest =
            serde_json::from_str(include_str!("../../resources/kokoro-model-manifest.json"))
                .expect("the bundled Kokoro manifest must be valid JSON");
        assert_eq!(parsed.sample_rate_hz, SAMPLE_RATE_HZ);
        assert_eq!(parsed.channels, 1);
        assert_eq!(parsed.artifacts.len(), 5);
        parsed
    })
}

fn total_size() -> u64 {
    manifest()
        .artifacts
        .iter()
        .map(|artifact| artifact.size)
        .sum()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KokoroStatusKind {
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
pub struct KokoroStatus {
    kind: KokoroStatusKind,
    supported: bool,
    model_revision: String,
    model_size_bytes: u64,
    downloaded_bytes: u64,
    total_bytes: u64,
    loaded: bool,
    error_code: Option<String>,
    message: Option<String>,
}

impl KokoroStatus {
    fn new(kind: KokoroStatusKind) -> Self {
        Self {
            kind,
            supported: compatible_platform(),
            model_revision: manifest().revision.clone(),
            model_size_bytes: total_size(),
            downloaded_bytes: 0,
            total_bytes: total_size(),
            loaded: false,
            error_code: None,
            message: None,
        }
    }

    fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        let mut status = Self::new(KokoroStatusKind::Error);
        status.error_code = Some(code.into());
        status.message = Some(message.into());
        status
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroVoice {
    id: &'static str,
    name: &'static str,
    locale: &'static str,
    quality: &'static str,
}

pub fn voices() -> Vec<KokoroVoice> {
    vec![
        KokoroVoice {
            id: "af_heart",
            name: "Heart",
            locale: "en",
            quality: "enhanced",
        },
        KokoroVoice {
            id: "ff_siwis",
            name: "Siwis",
            locale: "fr",
            quality: "enhanced",
        },
    ]
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroRequest {
    text: String,
    voice_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroSegment {
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
    artifacts: Vec<ActivatedArtifact>,
    accepted_license: String,
    accepted_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivatedArtifact {
    filename: String,
    sha256: String,
    size: u64,
}

enum WorkerRequest {
    Synthesize {
        model_path: PathBuf,
        voice_path: PathBuf,
        language: String,
        text: String,
        reply: oneshot::Sender<Result<Vec<f32>, String>>,
    },
    Unload {
        reply: oneshot::Sender<Result<(), String>>,
    },
}

pub struct KokoroManager {
    app: AppHandle,
    model_dir: PathBuf,
    worker: mpsc::SyncSender<WorkerRequest>,
    status: Arc<Mutex<KokoroStatus>>,
    installing: AtomicBool,
    cancel_install_requested: AtomicBool,
    loaded: AtomicBool,
}

impl KokoroManager {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let model_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("models")
            .join("kokoro-82m")
            .join(&manifest().revision);
        let initial = inspect_installation(&model_dir);
        let (worker, receiver) = mpsc::sync_channel(1);
        // CrispASR's built-in phonemizers look up these paths lazily on their
        // first synthesis. Point them at immutable, managed artifacts before
        // the Kokoro worker can open a session, so it never falls back to bare
        // letter-to-sound rules for lack of pronunciation data.
        std::env::set_var(
            "CRISPASR_CMUDICT_PATH",
            model_dir.join(&artifact_for_role("g2p-en")?.filename),
        );
        std::env::set_var(
            "CRISPASR_FR_DICT_PATH",
            model_dir.join(&artifact_for_role("g2p-fr")?.filename),
        );
        std::thread::Builder::new()
            .name("notabene-kokoro".into())
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
            .any(|backend| backend == "kokoro")
        {
            manager.replace_status(KokoroStatus::error(
                "TTS_NATIVE_RUNTIME_MISSING",
                "The bundled local speech runtime is unavailable. Reinstall NotaBene.",
            ));
        }

        Ok(manager)
    }

    pub fn status(&self) -> KokoroStatus {
        self.status_lock().clone()
    }

    pub async fn install(&self, accepted_license: bool) -> Result<KokoroStatus, String> {
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
                    let mut status = KokoroStatus::new(KokoroStatusKind::NotInstalled);
                    status.error_code = Some(code.into());
                    status.message = Some(message.into());
                    status
                } else {
                    KokoroStatus::error(code, message)
                };
                self.replace_status(status);
                self.publish_status();
                Err(error)
            }
        }
    }

    async fn install_inner(&self) -> Result<KokoroStatus, String> {
        tokio::fs::create_dir_all(&self.model_dir)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not create the model folder.")?;
        let free = fs2::available_space(&self.model_dir)
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not check available disk space.")?;
        if free < manifest().minimum_free_bytes {
            return Err("TTS_MODEL_INCOMPLETE: At least 320 MB of free space is required.".into());
        }

        self.prepare_installation().await?;
        let mut downloaded = 0u64;
        for artifact in &manifest().artifacts {
            downloaded = self.download_artifact(artifact, downloaded).await?;
        }

        let activation = ActivationRecord {
            revision: manifest().revision.clone(),
            artifacts: manifest()
                .artifacts
                .iter()
                .map(|artifact| ActivatedArtifact {
                    filename: artifact.filename.clone(),
                    sha256: artifact.sha256.clone(),
                    size: artifact.size,
                })
                .collect(),
            accepted_license: manifest().license.clone(),
            accepted_at: chrono::Utc::now().to_rfc3339(),
        };
        let activation_path = self.model_dir.join(ACTIVATION_FILE);
        let activation_partial = partial_path(&activation_path);
        let bytes = serde_json::to_vec_pretty(&activation)
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not record model activation.")?;
        tokio::fs::write(&activation_partial, bytes)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not record model activation.")?;
        tokio::fs::rename(&activation_partial, &activation_path)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not activate the model.")?;

        let mut status = KokoroStatus::new(KokoroStatusKind::Ready);
        status.downloaded_bytes = total_size();
        self.replace_status(status.clone());
        self.publish_status();
        Ok(status)
    }

    async fn download_artifact(
        &self,
        artifact: &Artifact,
        completed_bytes: u64,
    ) -> Result<u64, String> {
        let final_path = self.model_dir.join(&artifact.filename);
        let partial = partial_path(&final_path);

        // App updates can add pronunciation data to an existing Kokoro
        // installation. Re-hash and retain every valid artifact so repairing
        // it downloads only the files that are genuinely missing.
        if self
            .existing_artifact_matches(artifact, &final_path)
            .await?
        {
            self.update_progress(KokoroStatusKind::Verifying, completed_bytes + artifact.size);
            return Ok(completed_bytes + artifact.size);
        }
        remove_file_if_present(&final_path).await?;
        remove_file_if_present(&partial).await?;

        self.update_progress(KokoroStatusKind::Downloading, completed_bytes);
        let response = reqwest::Client::new()
            .get(&artifact.url)
            .send()
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: The model download failed.")?
            .error_for_status()
            .map_err(|_| "TTS_MODEL_INCOMPLETE: The model download failed.")?;
        if response.content_length() != Some(artifact.size) {
            return Err(
                "TTS_MODEL_INCOMPLETE: The server reported an unexpected model size.".into(),
            );
        }

        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not create the model file.")?;
        let mut stream = response.bytes_stream();
        let mut artifact_bytes = 0u64;
        let mut hasher = Sha256::new();
        let mut last_event = Instant::now();
        while let Some(next) = stream.next().await {
            if self.cancel_install_requested.load(Ordering::Acquire) {
                drop(file);
                let _ = tokio::fs::remove_file(&partial).await;
                return Err("TTS_CANCELLED: Model installation was cancelled.".into());
            }
            let chunk =
                next.map_err(|_| "TTS_MODEL_INCOMPLETE: The model download was interrupted.")?;
            artifact_bytes = artifact_bytes.saturating_add(chunk.len() as u64);
            if artifact_bytes > artifact.size {
                return Err("TTS_MODEL_INCOMPLETE: A model file is too large.".into());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not write a model file.")?;
            if last_event.elapsed() >= Duration::from_millis(200) {
                self.update_progress(
                    KokoroStatusKind::Downloading,
                    completed_bytes + artifact_bytes,
                );
                last_event = Instant::now();
            }
        }
        file.flush()
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not finish a model file.")?;
        file.sync_all()
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not finish a model file.")?;
        drop(file);

        self.update_progress(
            KokoroStatusKind::Verifying,
            completed_bytes + artifact_bytes,
        );
        let actual_hash = format!("{:x}", hasher.finalize());
        if artifact_bytes != artifact.size || actual_hash != artifact.sha256 {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(
                "TTS_MODEL_INCOMPLETE: A downloaded model file failed verification.".into(),
            );
        }
        tokio::fs::rename(&partial, &final_path)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not activate a model file.")?;
        Ok(completed_bytes + artifact_bytes)
    }

    async fn existing_artifact_matches(
        &self,
        artifact: &Artifact,
        path: &Path,
    ) -> Result<bool, String> {
        let metadata = match tokio::fs::metadata(path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("TTS_MODEL_INCOMPLETE: Could not inspect a model file.".into()),
        };
        if metadata.len() != artifact.size {
            return Ok(false);
        }

        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not verify a model file.")?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if self.cancel_install_requested.load(Ordering::Acquire) {
                return Err("TTS_CANCELLED: Model installation was cancelled.".into());
            }
            let count = file
                .read(&mut buffer)
                .await
                .map_err(|_| "TTS_MODEL_INCOMPLETE: Could not verify a model file.")?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        Ok(format!("{:x}", hasher.finalize()) == artifact.sha256)
    }

    async fn prepare_installation(&self) -> Result<(), String> {
        for artifact in &manifest().artifacts {
            remove_file_if_present(&partial_path(&self.model_dir.join(&artifact.filename))).await?;
        }
        let activation = self.model_dir.join(ACTIVATION_FILE);
        remove_file_if_present(&activation).await?;
        remove_file_if_present(&partial_path(&activation)).await
    }

    pub fn cancel_install(&self) -> Result<(), String> {
        if !self.installing.load(Ordering::Acquire) {
            return Err("TTS_CANCELLED: No model installation is running.".into());
        }
        self.cancel_install_requested.store(true, Ordering::Release);
        Ok(())
    }

    pub async fn synthesize(&self, request: KokoroRequest) -> Result<KokoroSegment, String> {
        require_supported()?;
        let text = request.text.trim();
        if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
            return Err(
                "TTS_GENERATION_FAILED: Speech chunks must contain 1–1,200 characters.".into(),
            );
        }
        let (language, voice_role) = match request.voice_id.as_str() {
            "af_heart" => ("en-us", "voice-en"),
            "ff_siwis" => ("fr", "voice-fr"),
            _ => return Err("TTS_GENERATION_FAILED: Unknown Kokoro voice.".into()),
        };
        let text = expand_numbers(text, language);
        if inspect_installation(&self.model_dir).kind != KokoroStatusKind::Ready {
            return Err("TTS_MODEL_NOT_INSTALLED: Install local Kokoro first.".into());
        }
        if LOCAL_SYNTHESIS_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("TTS_BUSY: Another local speech segment is being generated.".into());
        }
        let _synthesizing = AtomicReset(&LOCAL_SYNTHESIS_BUSY);
        if !self.loaded.load(Ordering::Acquire) {
            let mut status = KokoroStatus::new(KokoroStatusKind::Loading);
            status.downloaded_bytes = total_size();
            self.replace_status(status);
            self.publish_status();
        }

        let model = artifact_for_role("model")?;
        let voice = artifact_for_role(voice_role)?;
        let (reply, receive) = oneshot::channel();
        self.worker
            .try_send(WorkerRequest::Synthesize {
                model_path: self.model_dir.join(&model.filename),
                voice_path: self.model_dir.join(&voice.filename),
                language: language.into(),
                text,
                reply,
            })
            .map_err(|_| "TTS_BUSY: The local speech worker is busy.")?;
        let pcm = receive
            .await
            .map_err(|_| "TTS_GENERATION_FAILED: The local speech worker stopped.")??;
        let wav = encode_pcm_wav(&pcm)?;
        self.loaded.store(true, Ordering::Release);
        let mut status = KokoroStatus::new(KokoroStatusKind::Ready);
        status.downloaded_bytes = total_size();
        status.loaded = true;
        self.replace_status(status);
        self.publish_status();

        Ok(KokoroSegment {
            data: base64::engine::general_purpose::STANDARD.encode(&wav),
            mime: "audio/wav",
            duration_ms: (pcm.len() as u64 * 1000) / SAMPLE_RATE_HZ as u64,
            sample_rate_hz: SAMPLE_RATE_HZ,
            channels: 1,
        })
    }

    pub async fn unload(&self) -> Result<KokoroStatus, String> {
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

    pub async fn remove(&self) -> Result<KokoroStatus, String> {
        if self.installing.load(Ordering::Acquire) {
            return Err("TTS_BUSY: Cancel the model installation before removing it.".into());
        }
        self.unload().await?;
        match tokio::fs::remove_dir_all(&self.model_dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("TTS_MODEL_INCOMPLETE: Could not remove the model.".into()),
        }
        let status = KokoroStatus::new(KokoroStatusKind::NotInstalled);
        self.replace_status(status.clone());
        self.publish_status();
        Ok(status)
    }

    fn update_progress(&self, kind: KokoroStatusKind, downloaded: u64) {
        let mut status = KokoroStatus::new(kind);
        status.downloaded_bytes = downloaded;
        self.replace_status(status);
        self.publish_status();
    }

    fn publish_status(&self) {
        let _ = self.app.emit(INSTALL_EVENT, self.status());
    }

    fn replace_status(&self, status: KokoroStatus) {
        *self.status_lock() = status;
    }

    fn status_lock(&self) -> std::sync::MutexGuard<'_, KokoroStatus> {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn artifact_for_role(role: &str) -> Result<&'static Artifact, String> {
    manifest()
        .artifacts
        .iter()
        .find(|artifact| artifact.role == role)
        .ok_or_else(|| "TTS_MODEL_INCOMPLETE: The bundled model manifest is invalid.".into())
}

async fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("TTS_MODEL_INCOMPLETE: Could not replace a previous download.".into()),
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
        Err("TTS_KOKORO_UNSUPPORTED: Local Kokoro requires an Apple Silicon Mac.".into())
    }
}

fn inspect_installation(model_dir: &Path) -> KokoroStatus {
    if !compatible_platform() {
        let mut status = KokoroStatus::new(KokoroStatusKind::Unsupported);
        status.error_code = Some("TTS_KOKORO_UNSUPPORTED".into());
        status.message = Some("Local Kokoro requires an Apple Silicon Mac.".into());
        return status;
    }
    let mut installed_bytes = 0u64;
    for artifact in &manifest().artifacts {
        let final_path = model_dir.join(&artifact.filename);
        let partial = partial_path(&final_path);
        if partial.exists() {
            let mut status = KokoroStatus::error(
                "TTS_MODEL_INCOMPLETE",
                "An incomplete model download must be retried.",
            );
            status.downloaded_bytes =
                installed_bytes + std::fs::metadata(partial).map(|m| m.len()).unwrap_or(0);
            return status;
        }
        let Ok(metadata) = std::fs::metadata(final_path) else {
            return KokoroStatus::new(KokoroStatusKind::NotInstalled);
        };
        if metadata.len() != artifact.size {
            return KokoroStatus::error(
                "TTS_MODEL_INCOMPLETE",
                "An installed model file has an unexpected size.",
            );
        }
        installed_bytes += artifact.size;
    }

    let Ok(mut file) = std::fs::File::open(model_dir.join(ACTIVATION_FILE)) else {
        return KokoroStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The installed model has no valid activation record.",
        );
    };
    let mut contents = String::new();
    if file.read_to_string(&mut contents).is_err() {
        return KokoroStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The model activation record could not be read.",
        );
    }
    let Ok(activation) = serde_json::from_str::<ActivationRecord>(&contents) else {
        return KokoroStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The model activation record is invalid.",
        );
    };
    let activation_matches = activation.revision == manifest().revision
        && activation.accepted_license == manifest().license
        && activation.artifacts.len() == manifest().artifacts.len()
        && manifest().artifacts.iter().all(|artifact| {
            activation.artifacts.iter().any(|installed| {
                installed.filename == artifact.filename
                    && installed.sha256 == artifact.sha256
                    && installed.size == artifact.size
            })
        });
    if !activation_matches {
        return KokoroStatus::error(
            "TTS_MODEL_INCOMPLETE",
            "The model activation record does not match this app version.",
        );
    }
    let mut status = KokoroStatus::new(KokoroStatusKind::Ready);
    status.downloaded_bytes = installed_bytes;
    status
}

fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".partial");
    PathBuf::from(name)
}

fn split_error(error: &str) -> (&str, &str) {
    error
        .split_once(':')
        .map(|(code, message)| (code.trim(), message.trim()))
        .unwrap_or(("TTS_GENERATION_FAILED", "Local speech failed."))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn worker_loop(receiver: mpsc::Receiver<WorkerRequest>) {
    let mut open: Option<(PathBuf, PathBuf, String, Session)> = None;
    while let Ok(request) = receiver.recv() {
        match request {
            WorkerRequest::Synthesize {
                model_path,
                voice_path,
                language,
                text,
                reply,
            } => {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let must_open = open.as_ref().is_none_or(
                        |(loaded_model, loaded_voice, loaded_language, _)| {
                            loaded_model != &model_path
                                || loaded_voice != &voice_path
                                || loaded_language != &language
                        },
                    );
                    if must_open {
                        let threads = std::thread::available_parallelism()
                            .map(|value| value.get().clamp(2, 8) as i32)
                            .unwrap_or(4);
                        let session = Session::open_with_backend(
                            model_path.to_string_lossy().as_ref(),
                            "kokoro",
                            threads,
                        )
                        .map_err(|detail| {
                            eprintln!("Kokoro model load failed: {detail}");
                            "TTS_MODEL_LOAD_FAILED: The local model could not be loaded."
                                .to_string()
                        })?;
                        session.set_source_language(&language).map_err(|detail| {
                            eprintln!("Kokoro language selection failed: {detail}");
                            "TTS_GENERATION_FAILED: The speech language could not be selected."
                                .to_string()
                        })?;
                        session
                            .set_voice(voice_path.to_string_lossy().as_ref(), None)
                            .map_err(|detail| {
                                eprintln!("Kokoro voice load failed: {detail}");
                                "TTS_MODEL_LOAD_FAILED: The Kokoro voice could not be loaded."
                                    .to_string()
                            })?;
                        open = Some((
                            model_path.clone(),
                            voice_path.clone(),
                            language.clone(),
                            session,
                        ));
                    }
                    open.as_ref()
                        .expect("session was opened")
                        .3
                        .synthesize(&text)
                        .map_err(|detail| {
                            eprintln!("Kokoro synthesis failed: {detail}");
                            "TTS_GENERATION_FAILED: Local speech generation failed.".to_string()
                        })
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
                    "TTS_KOKORO_UNSUPPORTED: Local Kokoro requires Apple Silicon.".into(),
                ));
            }
            WorkerRequest::Unload { reply } => {
                let _ = reply.send(Ok(()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_pinned_q8_with_voice_and_pronunciation_packs() {
        let model = manifest();
        assert_eq!(model.runtime_tag, "v0.8.23");
        assert_eq!(model.repository, "cstr/kokoro-82m-GGUF");
        assert_eq!(artifact_for_role("model").unwrap().size, 141_322_336);
        assert_eq!(total_size(), 152_825_855);
        assert!(artifact_for_role("voice-en").is_ok());
        assert!(artifact_for_role("voice-fr").is_ok());
        assert_eq!(
            artifact_for_role("g2p-en").unwrap().revision.as_deref(),
            Some("80c2f587f2a1d7bcc7d703dc084bfb71b6c862ad")
        );
        assert_eq!(
            artifact_for_role("g2p-fr").unwrap().revision.as_deref(),
            Some("80c2f587f2a1d7bcc7d703dc084bfb71b6c862ad")
        );
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires the five pinned Kokoro artifacts"]
    fn binding_smoke() {
        let model = std::env::var("NOTABENE_KOKORO_MODEL").unwrap();
        std::env::set_var(
            "CRISPASR_CMUDICT_PATH",
            std::env::var("NOTABENE_KOKORO_G2P_EN").unwrap(),
        );
        std::env::set_var(
            "CRISPASR_FR_DICT_PATH",
            std::env::var("NOTABENE_KOKORO_G2P_FR").unwrap(),
        );
        for (language, voice_variable, text) in [
            (
                "en-us",
                "NOTABENE_KOKORO_VOICE_EN",
                "The knight writes notes beside the castle.",
            ),
            (
                "fr",
                "NOTABENE_KOKORO_VOICE_FR",
                "Ils parlent souvent et les enfants jouent dans le grand château.",
            ),
        ] {
            let voice = std::env::var(voice_variable).unwrap();
            let session = Session::open_with_backend(&model, "kokoro", 4).unwrap();
            session.set_source_language(language).unwrap();
            session.set_voice(&voice, None).unwrap();
            let pcm = session.synthesize(text).unwrap();
            assert!(encode_pcm_wav(&pcm).unwrap().len() > 44);
        }
    }
}
