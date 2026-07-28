use super::compatibility::{detect, Compatibility};
use super::download;
use super::manifest::ModelManifest;
use crate::tts::types::EngineState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

struct ModelManager {
    state: EngineState,
    cancelled: Arc<AtomicBool>,
}

fn manager() -> &'static Mutex<ModelManager> {
    static MANAGER: OnceLock<Mutex<ModelManager>> = OnceLock::new();
    MANAGER.get_or_init(|| {
        Mutex::new(ModelManager {
            state: EngineState::NotInstalled,
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    })
}

pub fn model_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("models/voxtral/2603-mlx-4bit"))
        .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))
}

fn installed(app: &AppHandle, manifest: &ModelManifest) -> bool {
    model_root(app)
        .map(|root| {
            root.join(&manifest.revision)
                .join("manifest.json")
                .is_file()
        })
        .unwrap_or(false)
}

pub fn status(app: &AppHandle) -> EngineState {
    if let Compatibility::Unsupported { code, reason } = detect() {
        return EngineState::Unsupported {
            reason,
            code: Some(code.into()),
        };
    }
    let Ok(manifest) = ModelManifest::bundled() else {
        return EngineState::Error {
            code: "TTS_MODEL_CORRUPT".into(),
            recoverable: false,
            message: Some("The bundled Voxtral manifest is invalid.".into()),
        };
    };
    let state = manager().lock().unwrap().state.clone();
    match state {
        EngineState::NotInstalled if installed(app, &manifest) => EngineState::Installed,
        other => other,
    }
}

pub fn install(app: AppHandle, accepted_license: String) -> Result<(), String> {
    if accepted_license != "CC-BY-NC-4.0" {
        return Err("TTS_MODEL_LICENSE_NOT_ACCEPTED: accept CC BY-NC 4.0 first".into());
    }
    if let Compatibility::Unsupported { code, reason } = detect() {
        return Err(format!("{code}: {reason}"));
    }
    let manifest = ModelManifest::bundled()?;
    let root = model_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;
    let acceptance = serde_json::json!({
        "modelId": manifest.model_id,
        "revision": manifest.revision,
        "license": manifest.license,
        "acceptedAt": chrono::Utc::now().to_rfc3339(),
    });
    std::fs::write(
        root.join("license-acceptance.json"),
        serde_json::to_vec_pretty(&acceptance).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("TTS_MODEL_CORRUPT: {error}"))?;

    let mut guard = manager().lock().unwrap();
    if matches!(
        guard.state,
        EngineState::Downloading { .. } | EngineState::Verifying
    ) {
        return Ok(());
    }
    guard.cancelled = Arc::new(AtomicBool::new(false));
    let cancelled = guard.cancelled.clone();
    let total = manifest.total_bytes();
    guard.state = EngineState::Downloading {
        downloaded_bytes: 0,
        total_bytes: total,
    };
    drop(guard);

    tauri::async_runtime::spawn(async move {
        let result = download::install(&manifest, &root, &cancelled, |downloaded, total| {
            manager().lock().unwrap().state = if downloaded >= total {
                EngineState::Verifying
            } else {
                EngineState::Downloading {
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                }
            };
        })
        .await;
        let mut guard = manager().lock().unwrap();
        guard.state = match result {
            Ok(_) => EngineState::Installed,
            Err(error) if error.starts_with("TTS_DOWNLOAD_CANCELLED") => EngineState::NotInstalled,
            Err(error) => {
                let code = error
                    .split_once(':')
                    .map(|(code, _)| code)
                    .unwrap_or("TTS_DOWNLOAD_NETWORK")
                    .to_string();
                EngineState::Error {
                    recoverable: matches!(
                        code.as_str(),
                        "TTS_DOWNLOAD_NETWORK" | "TTS_INSUFFICIENT_DISK" | "TTS_MODEL_CHECKSUM"
                    ),
                    code,
                    message: Some(error),
                }
            }
        };
    });
    Ok(())
}

pub fn cancel_install() {
    let mut guard = manager().lock().unwrap();
    guard.cancelled.store(true, Ordering::Relaxed);
    guard.state = EngineState::NotInstalled;
}

pub fn remove(app: &AppHandle) -> Result<(), String> {
    let guard = manager().lock().unwrap();
    if matches!(
        guard.state,
        EngineState::Downloading { .. }
            | EngineState::Verifying
            | EngineState::Loading
            | EngineState::Busy { .. }
    ) {
        return Err("TTS_BUSY: stop Voxtral before removing it".into());
    }
    drop(guard);
    let manifest = ModelManifest::bundled()?;
    let root = model_root(app)?;
    download::remove_installed(&root, &manifest)?;
    manager().lock().unwrap().state = EngineState::NotInstalled;
    Ok(())
}

pub fn mark_error(code: &str, message: &str, recoverable: bool) {
    manager().lock().unwrap().state = EngineState::Error {
        code: code.into(),
        recoverable,
        message: Some(message.into()),
    };
}

pub fn mark_loading() {
    manager().lock().unwrap().state = EngineState::Loading;
}

pub fn mark_ready() {
    manager().lock().unwrap().state = EngineState::Ready;
}

pub fn mark_busy(request_id: &str) {
    manager().lock().unwrap().state = EngineState::Busy {
        job_id: request_id.into(),
    };
}

pub fn worker_shutdown() {
    let mut guard = manager().lock().unwrap();
    if matches!(
        guard.state,
        EngineState::Loading
            | EngineState::Ready
            | EngineState::Busy { .. }
            | EngineState::Error { .. }
    ) {
        guard.state = EngineState::Installed;
    }
}
