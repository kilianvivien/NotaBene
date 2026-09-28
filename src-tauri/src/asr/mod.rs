//! Transcription's platform half (plan §10.3).
//!
//! The pipeline — windows, progress, cancel, stitching, the transcript note —
//! is TypeScript (`src/lib/commands/transcriptionCommands.ts`). This module
//! owns what the webview must not: the audio. A lecture is read from the asset
//! store **by id, in Rust**, decoded once into a job directory, and handed to
//! an engine a window at a time — to the `notabene-speech` helper for Apple's
//! on-device recogniser, or to `ai.rs` for a hosted engine, which attaches the
//! window file to the request itself. Audio never crosses IPC, the rule
//! `recording.rs` already follows.
//!
//! A job is a directory under `asr-jobs/` in app data: `audio.wav` (16 kHz
//! mono, about 115 MB an hour) and the window files cut from it. Releasing a
//! job deletes it, and a launch deletes whatever a crash left, since nothing
//! can be running in a process that has just started.

mod apple;
mod audio;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::asset_file_path;
use crate::db::location::LibraryAccess;

use audio::{PcmLayout, Window};

const JOBS_DIR: &str = "asr-jobs";
pub const INSTALL_PROGRESS_EVENT: &str = "notabene-asr-install-progress";

/// Mistral's documented ceiling for `context_bias`, and more than a course's
/// accepted terms usually run to.
const MAX_CONTEXT_TERMS: usize = 100;
const MAX_TERM_CHARS: usize = 100;

/// Enough speech to tell French from English with room to spare.
const PROBE_MS: u64 = 45_000;

struct Job {
    dir: PathBuf,
    layout: PcmLayout,
    windows: Vec<Window>,
    speech_start_ms: u64,
    helper: apple::RunningHelper,
}

#[derive(Default)]
pub struct AsrJobs(Mutex<HashMap<String, Arc<Job>>>);

impl AsrJobs {
    fn get(&self, id: &str) -> Result<Arc<Job>, String> {
        self.0
            .lock()
            .map_err(|_| "asr state poisoned")?
            .get(id)
            .cloned()
            .ok_or_else(|| "ASR_JOB_MISSING: that transcription is not running".into())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobWindow {
    index: usize,
    start_ms: u64,
    end_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPlan {
    job_id: String,
    duration_ms: u64,
    windows: Vec<JobWindow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    job_id: String,
    asset_id: String,
    window_seconds: u64,
    overlap_seconds: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    locale: String,
    fraction: f64,
}

/// Register state and sweep what an earlier run left behind.
pub fn init(app: &AppHandle) {
    if let Ok(dir) = jobs_dir(app) {
        let _ = fs::remove_dir_all(dir);
    }
    app.manage(AsrJobs::default());
}

fn jobs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::db::data_dir(app)
        .map(|dir| dir.join(JOBS_DIR))
        .map_err(|error| error.to_string())
}

/// Job ids become directory names; the same alphabet as a recording id.
fn check_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err("invalid job id".into())
    }
}

fn check_context(terms: &[String]) -> Result<(), String> {
    if terms.len() > MAX_CONTEXT_TERMS {
        return Err("too many vocabulary terms".into());
    }
    for term in terms {
        let length = term.chars().count();
        if length == 0 || length > MAX_TERM_CHARS || term.chars().any(char::is_control) {
            return Err("invalid vocabulary term".into());
        }
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

/// Decode the attachment's audio and plan its windows.
#[tauri::command]
pub async fn asr_prepare(
    app: AppHandle,
    jobs: State<'_, AsrJobs>,
    access: State<'_, LibraryAccess>,
    request: PrepareRequest,
) -> Result<JobPlan, String> {
    check_id(&request.job_id)?;
    if !(30..=900).contains(&request.window_seconds) || request.overlap_seconds > 10 {
        return Err("invalid window".into());
    }
    let source = asset_file_path(&access, &request.asset_id).map_err(|error| error.to_string())?;
    if !source.is_file() {
        return Err("ASR_AUDIO_MISSING: the recording's file is missing".into());
    }
    let dir = jobs_dir(&app)?.join(&request.job_id);
    let window_ms = request.window_seconds * 1000;
    let overlap_ms = request.overlap_seconds * 1000;

    let task_dir = dir.clone();
    let prepared = blocking(move || {
        fs::create_dir_all(&task_dir).map_err(|error| error.to_string())?;
        let wav = task_dir.join("audio.wav");
        audio::decode_to_wav(&source, &wav)?;
        let layout = audio::pcm_layout(&wav)?;
        if layout.duration_ms() > audio::MAX_DURATION_MS {
            return Err("ASR_AUDIO_TOO_LONG: recordings over ten hours are refused".into());
        }
        let frames = audio::frame_energy(&wav, layout)?;
        let windows = audio::plan_windows(&frames, window_ms, overlap_ms);
        if windows.is_empty() {
            return Err("ASR_AUDIO_EMPTY: the recording holds no audio".into());
        }
        Ok((layout, windows, audio::speech_start_ms(&frames)))
    })
    .await;
    let (layout, windows, speech_start_ms) = match prepared {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(error);
        }
    };

    let plan = JobPlan {
        job_id: request.job_id.clone(),
        duration_ms: layout.duration_ms(),
        windows: windows
            .iter()
            .enumerate()
            .map(|(index, window)| JobWindow {
                index,
                start_ms: window.start_ms,
                end_ms: window.end_ms,
            })
            .collect(),
    };
    jobs.0.lock().map_err(|_| "asr state poisoned")?.insert(
        request.job_id,
        Arc::new(Job {
            dir,
            layout,
            windows,
            speech_start_ms,
            helper: apple::RunningHelper::default(),
        }),
    );
    Ok(plan)
}

/// Stop whatever the job is running now. The pipeline checks its own signal
/// between windows; this is what makes a cancel land inside one.
#[tauri::command]
pub fn asr_cancel(jobs: State<'_, AsrJobs>, job_id: String) -> Result<(), String> {
    check_id(&job_id)?;
    if let Ok(job) = jobs.get(&job_id) {
        if let Some(mut child) = job.helper.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

/// Delete the job's files. Always called, success or not; unknown ids are
/// fine, so a release after a failed prepare does not itself fail.
#[tauri::command]
pub async fn asr_release(
    app: AppHandle,
    jobs: State<'_, AsrJobs>,
    job_id: String,
) -> Result<(), String> {
    check_id(&job_id)?;
    let job = jobs
        .0
        .lock()
        .map_err(|_| "asr state poisoned")?
        .remove(&job_id);
    if let Some(job) = &job {
        if let Some(mut child) = job.helper.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let dir = jobs_dir(&app)?.join(&job_id);
    blocking(move || match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    })
    .await
}

fn window_wav(job: &Job, index: usize) -> Result<PathBuf, String> {
    let window = *job.windows.get(index).ok_or("no such window")?;
    let path = job.dir.join(format!("w{index}.wav"));
    if !path.is_file() {
        audio::write_window(&job.dir.join("audio.wav"), job.layout, window, &path)?;
    }
    Ok(path)
}

/// One window as AAC, for a hosted engine. Called by `ai.rs` when a request
/// names a window; the bytes go straight into the multipart body.
pub async fn window_aac(app: &AppHandle, job_id: &str, index: usize) -> Result<Vec<u8>, String> {
    check_id(job_id)?;
    let job = app.state::<AsrJobs>().get(job_id)?;
    blocking(move || {
        let wav = window_wav(&job, index)?;
        let aac = job.dir.join(format!("w{index}.m4a"));
        audio::encode_aac(&wav, &aac)?;
        let bytes = fs::read(&aac).map_err(|error| error.to_string())?;
        // Sent once; a retry encodes it again.
        let _ = fs::remove_file(&aac);
        Ok(bytes)
    })
    .await
}

// -- Apple's on-device recogniser ------------------------------------------

/// Which languages the Mac can transcribe, and whether each one's model is
/// installed. Never downloads anything.
#[tauri::command]
pub async fn asr_apple_status(locales: Vec<String>) -> Result<Value, String> {
    for locale in &locales {
        apple::check_locale(locale)?;
    }
    blocking(move || {
        let mut arguments = vec!["status".to_string()];
        for locale in locales {
            arguments.push("--locale".into());
            arguments.push(locale);
        }
        apple::run(&arguments, None)
    })
    .await
}

/// Install one language's recognition model — Apple's download, from
/// Apple, the way a dictation language is added. Only on the student's click.
#[tauri::command]
pub async fn asr_apple_install(app: AppHandle, locale: String) -> Result<(), String> {
    apple::check_locale(&locale)?;
    blocking(move || {
        let arguments = vec!["install".to_string(), "--locale".into(), locale.clone()];
        apple::run_with_progress(&arguments, |fraction| {
            let _ = app.emit(
                INSTALL_PROGRESS_EVENT,
                InstallProgress {
                    locale: locale.clone(),
                    fraction,
                },
            );
        })
    })
    .await
}

/// Which of `locales` the lecture is in, from a probe of its first speech.
#[tauri::command]
pub async fn asr_apple_detect(
    jobs: State<'_, AsrJobs>,
    job_id: String,
    locales: Vec<String>,
) -> Result<Value, String> {
    check_id(&job_id)?;
    for locale in &locales {
        apple::check_locale(locale)?;
    }
    let job = jobs.get(&job_id)?;
    blocking(move || {
        let probe = job.dir.join("probe.wav");
        let start = job.speech_start_ms;
        let end = (start + PROBE_MS).min(job.layout.duration_ms());
        audio::write_window(
            &job.dir.join("audio.wav"),
            job.layout,
            Window {
                start_ms: start,
                end_ms: end,
            },
            &probe,
        )?;
        let mut arguments = vec![
            "detect".to_string(),
            "--file".into(),
            probe.display().to_string(),
        ];
        for locale in locales {
            arguments.push("--locale".into());
            arguments.push(locale);
        }
        let result = apple::run(&arguments, Some(&job.helper));
        let _ = fs::remove_file(&probe);
        result
    })
    .await
}

/// Transcribe one window. Times in the answer are relative to the window;
/// the pipeline shifts them.
#[tauri::command]
pub async fn asr_apple_transcribe(
    jobs: State<'_, AsrJobs>,
    job_id: String,
    index: usize,
    locale: String,
    context: Vec<String>,
) -> Result<Value, String> {
    check_id(&job_id)?;
    apple::check_locale(&locale)?;
    check_context(&context)?;
    let job = jobs.get(&job_id)?;
    blocking(move || {
        let wav = window_wav(&job, index)?;
        let result = apple::run(
            &apple::transcribe_arguments(&wav, &locale, &context),
            Some(&job.helper),
        );
        let _ = fs::remove_file(&wav);
        result
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_ids_that_could_leave_the_directory_are_refused() {
        assert!(check_id("job-1_A").is_ok());
        for bad in ["", "..", "a/b", "a.b", &"x".repeat(65)] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn vocabulary_is_bounded_and_plain() {
        assert!(check_context(&["cycle de Calvin".into()]).is_ok());
        assert!(check_context(&vec!["x".to_string(); 101]).is_err());
        assert!(check_context(&["".into()]).is_err());
        assert!(check_context(&["a\nb".into()]).is_err());
        assert!(check_context(&["y".repeat(101)]).is_err());
    }
}
