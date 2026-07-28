use super::manager;
use super::manifest::ModelManifest;
use super::protocol::{read_frame, write_frame, WorkerCommand, WorkerMessage, PROTOCOL_VERSION};
use crate::tts::types::{AudioEvent, StreamRequest};
use base64::Engine;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

const IDLE_SHUTDOWN_DELAY: Duration = Duration::from_secs(120);

struct Process {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<BufReader<ChildStdout>>,
    busy: AtomicBool,
    idle_generation: AtomicU64,
    idle_monitor_started: AtomicBool,
    active_request: Mutex<Option<String>>,
}

fn slot() -> &'static Mutex<Option<Arc<Process>>> {
    static PROCESS: OnceLock<Mutex<Option<Arc<Process>>>> = OnceLock::new();
    PROCESS.get_or_init(|| Mutex::new(None))
}

fn executable(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("sidecars/voxtral-worker-aarch64-apple-darwin/voxtral-worker");
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| format!("TTS_WORKER_LAUNCH: {error}"))?
        .join(&relative);
    if bundled.is_file() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if development.is_file() {
        return Ok(development);
    }
    Err("TTS_WORKER_LAUNCH: the signed Voxtral worker is not present in this build".into())
}

fn model_directory(app: &AppHandle, manifest: &ModelManifest) -> Result<PathBuf, String> {
    let directory = manager::model_root(app)?.join(&manifest.revision);
    if !directory.join("manifest.json").is_file() {
        return Err("TTS_MODEL_NOT_INSTALLED: install Voxtral first".into());
    }
    Ok(directory)
}

fn launch(app: &AppHandle) -> Result<Arc<Process>, String> {
    let manifest = ModelManifest::bundled()?;
    let model_directory = model_directory(app, &manifest)?;
    let mut child = Command::new(executable(app)?)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("TTS_WORKER_LAUNCH: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or("TTS_WORKER_LAUNCH: worker refused stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("TTS_WORKER_LAUNCH: worker refused stdout")?;
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut bounded = [0u8; 8192];
            // Drain to prevent a blocked child, but never log worker output:
            // upstream exceptions can contain paths or request fragments.
            while stderr.read(&mut bounded).is_ok_and(|read| read > 0) {}
        });
    }
    let process = Arc::new(Process {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        stdout: Mutex::new(BufReader::new(stdout)),
        busy: AtomicBool::new(false),
        idle_generation: AtomicU64::new(0),
        idle_monitor_started: AtomicBool::new(false),
        active_request: Mutex::new(None),
    });

    let initialized = (|| {
        let hello = WorkerCommand::Hello {
            protocol_version: PROTOCOL_VERSION,
            expected_model_id: manifest.model_id.clone(),
            expected_model_revision: manifest.revision.clone(),
            model_directory: model_directory.to_string_lossy().into_owned(),
        };
        write_frame(&mut *process.stdin.lock().unwrap(), &hello)?;
        let ready = read_frame::<WorkerMessage>(&mut *process.stdout.lock().unwrap())?;
        validate_ready(&ready, &manifest, false)?;
        manager::mark_loading();
        write_frame(&mut *process.stdin.lock().unwrap(), &WorkerCommand::Load)?;
        loop {
            let message = read_frame::<WorkerMessage>(&mut *process.stdout.lock().unwrap())?;
            match message {
                WorkerMessage::LoadingProgress { .. } => continue,
                ready @ WorkerMessage::Ready { loaded: true, .. } => {
                    validate_ready(&ready, &manifest, true)?;
                    break;
                }
                WorkerMessage::Error { code, message, .. } => {
                    return Err(format!("{code}: {message}"));
                }
                _ => return Err("TTS_WORKER_PROTOCOL: unexpected load response".into()),
            }
        }
        Ok(())
    })();
    if let Err(error) = initialized {
        // `Child` does not kill on drop. A handshake or model-load failure
        // therefore has to terminate explicitly or it can retain the model's
        // unified-memory allocation even though no process was put in `slot`.
        stop_process(&process);
        return Err(error);
    }
    manager::mark_ready();
    Ok(process)
}

fn validate_ready(
    message: &WorkerMessage,
    manifest: &ModelManifest,
    expected_loaded: bool,
) -> Result<(), String> {
    let WorkerMessage::Ready {
        protocol_version,
        runtime_version,
        model_id,
        model_revision,
        voices,
        sample_rate_hz,
        loaded,
    } = message
    else {
        return Err("TTS_WORKER_PROTOCOL: worker did not complete handshake".into());
    };
    if *protocol_version != PROTOCOL_VERSION
        || model_id != &manifest.model_id
        || model_revision != &manifest.revision
        || *sample_rate_hz != 24_000
        || *loaded != expected_loaded
        || runtime_version.is_empty()
        || voices.len() != 20
    {
        return Err("TTS_WORKER_PROTOCOL: worker handshake mismatch".into());
    }
    Ok(())
}

fn ensure(app: &AppHandle) -> Result<Arc<Process>, String> {
    let mut guard = slot().lock().unwrap();
    if let Some(process) = guard.as_ref() {
        if process
            .child
            .lock()
            .unwrap()
            .try_wait()
            .ok()
            .flatten()
            .is_none()
        {
            // Cancel an older idle timer before releasing the slot lock. That
            // closes the race where the timer could remove a process between
            // `ensure` returning it and the caller marking it busy.
            process.idle_generation.fetch_add(1, Ordering::AcqRel);
            return Ok(process.clone());
        }
        *guard = None;
    }
    let process = launch(app)?;
    *guard = Some(process.clone());
    Ok(process)
}

fn stop_process(process: &Arc<Process>) {
    let _ = write_frame(
        &mut *process.stdin.lock().unwrap(),
        &WorkerCommand::Shutdown,
    );
    let mut child = process.child.lock().unwrap();
    for _ in 0..15 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn schedule_idle_shutdown(process: Arc<Process>) {
    process.idle_generation.fetch_add(1, Ordering::AcqRel);
    if process
        .idle_monitor_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        let mut observed_generation = process.idle_generation.load(Ordering::Acquire);
        loop {
            std::thread::sleep(IDLE_SHUTDOWN_DELAY);
            let removed = {
                let mut guard = slot().lock().unwrap();
                let is_current = guard
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &process));
                if !is_current {
                    return;
                }
                let generation = process.idle_generation.load(Ordering::Acquire);
                if process.busy.load(Ordering::Acquire) || generation != observed_generation {
                    observed_generation = generation;
                    None
                } else {
                    guard.take()
                }
            };
            if let Some(process) = removed {
                // Exiting the process, rather than merely dropping the Python model
                // object, is what guarantees MLX and unified-memory caches return
                // to macOS.
                stop_process(&process);
                manager::worker_shutdown();
                return;
            }
        }
    });
}

pub async fn synthesize(
    app: AppHandle,
    request: StreamRequest,
    channel: Channel<AudioEvent>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || synthesize_blocking(&app, request, channel))
        .await
        .map_err(|error| format!("TTS_WORKER_CRASHED: {error}"))?
}

fn synthesize_blocking(
    app: &AppHandle,
    request: StreamRequest,
    channel: Channel<AudioEvent>,
) -> Result<(), String> {
    let process = ensure(app)?;
    if process
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return Err("TTS_BUSY: another local synthesis is already running".into());
    }
    struct BusyReset(Arc<Process>);
    impl Drop for BusyReset {
        fn drop(&mut self) {
            self.0.busy.store(false, Ordering::Release);
            *self.0.active_request.lock().unwrap() = None;
            manager::mark_ready();
            schedule_idle_shutdown(self.0.clone());
        }
    }
    let _reset = BusyReset(process.clone());
    *process.active_request.lock().unwrap() = Some(request.request_id.clone());
    manager::mark_busy(&request.request_id);

    let command = WorkerCommand::Synthesize {
        request_id: request.request_id.clone(),
        text: request.text,
        voice_id: request.voice_id,
        seed: 0,
        chunk_seconds: 1.0,
    };
    write_frame(&mut *process.stdin.lock().unwrap(), &command)?;
    let mut expected_sequence = 0;
    let mut started = false;
    let mut receiver_open = true;
    loop {
        let message = read_frame::<WorkerMessage>(&mut *process.stdout.lock().unwrap())?;
        match message {
            WorkerMessage::Started {
                request_id,
                sample_rate_hz,
                channels,
                encoding,
            } if request_id == request.request_id
                && sample_rate_hz == 24_000
                && channels == 1
                && encoding == "pcm_s16le" =>
            {
                started = true;
                deliver(
                    &process,
                    &request.request_id,
                    &channel,
                    &mut receiver_open,
                    AudioEvent::Started {
                        request_id,
                        sample_rate_hz,
                        channels,
                        encoding: "pcm_s16le",
                    },
                );
            }
            WorkerMessage::Audio {
                request_id,
                sequence,
                pcm,
                sample_count,
            } if started
                && request_id == request.request_id
                && sequence == expected_sequence
                && pcm.len() == sample_count as usize * 2
                && sample_count <= 36_000 =>
            {
                expected_sequence += 1;
                deliver(
                    &process,
                    &request.request_id,
                    &channel,
                    &mut receiver_open,
                    AudioEvent::Audio {
                        request_id,
                        sequence,
                        data_base64: base64::engine::general_purpose::STANDARD.encode(pcm),
                        sample_count,
                    },
                );
            }
            WorkerMessage::GenerationProgress {
                request_id,
                generated_samples,
            } if request_id == request.request_id => {
                deliver(
                    &process,
                    &request.request_id,
                    &channel,
                    &mut receiver_open,
                    AudioEvent::Progress {
                        request_id,
                        generated_samples,
                    },
                );
            }
            WorkerMessage::Done {
                request_id,
                total_samples,
                duration_ms,
            } if started && request_id == request.request_id => {
                if receiver_open {
                    let _ = channel.send(AudioEvent::Done {
                        request_id,
                        total_samples,
                        duration_ms,
                    });
                    return Ok(());
                }
                return Err("TTS_GENERATION_CANCELLED: receiver closed".into());
            }
            WorkerMessage::Cancelled { request_id } if request_id == request.request_id => {
                return Err("TTS_GENERATION_CANCELLED: synthesis cancelled".into());
            }
            WorkerMessage::Error {
                request_id,
                code,
                message,
                recoverable,
            } if request_id.is_empty() || request_id == request.request_id => {
                let _ = channel.send(AudioEvent::Error {
                    request_id: request.request_id,
                    code: code.clone(),
                    message: message.clone(),
                    recoverable,
                });
                return Err(format!("{code}: {message}"));
            }
            _ => return Err("TTS_WORKER_PROTOCOL: invalid or out-of-order worker frame".into()),
        }
    }
}

fn deliver(
    process: &Process,
    request_id: &str,
    channel: &Channel<AudioEvent>,
    receiver_open: &mut bool,
    event: AudioEvent,
) {
    if !*receiver_open || channel.send(event).is_ok() {
        return;
    }
    *receiver_open = false;
    let _ = write_frame(
        &mut *process.stdin.lock().unwrap(),
        &WorkerCommand::Cancel {
            request_id: request_id.into(),
        },
    );
}

pub fn cancel(request_id: &str) {
    let process = slot().lock().unwrap().clone();
    let Some(process) = process else {
        return;
    };
    if process.active_request.lock().unwrap().as_deref() != Some(request_id) {
        return;
    }
    let _ = write_frame(
        &mut *process.stdin.lock().unwrap(),
        &WorkerCommand::Cancel {
            request_id: request_id.into(),
        },
    );
}

pub fn shutdown() {
    let process = slot().lock().unwrap().take();
    let Some(process) = process else {
        manager::worker_shutdown();
        return;
    };
    stop_process(&process);
    manager::worker_shutdown();
}
