//! Running `notabene-speech`, the Swift helper around macOS's
//! `SpeechTranscriber` (`src-tauri/speech/main.swift`).
//!
//! One process per call, as `say(1)` is for speech synthesis. A window is a
//! few minutes of audio and the recogniser loads in a fraction of a second,
//! so there is no model to keep warm here — and a process is also the
//! cancel: killing it stops recognition mid-window, which a call inside our
//! own process could not do.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

/// A four-minute window takes seconds on Apple silicon; one that has not
/// finished in this long is wedged.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Beside the app's own executable — where Tauri puts an external binary,
/// both in the bundle and under `target/` in development.
pub fn helper_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let path = exe
        .parent()
        .ok_or("the app has no directory")?
        .join("notabene-speech");
    if path.is_file() {
        Ok(path)
    } else {
        Err("ASR_UNSUPPORTED: the speech helper is missing from this build".into())
    }
}

/// The helper a running job may kill. `None` while nothing is running.
pub type RunningHelper = Arc<Mutex<Option<Child>>>;

/// Run the helper and parse its one line of JSON. Its failures arrive as
/// `{"error": code, "message"}` on stderr and become `ASR_APPLE_{CODE}: …`,
/// which the webview translates.
pub fn run(arguments: &[String], running: Option<&RunningHelper>) -> Result<Value, String> {
    let mut child = Command::new(helper_path()?)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ASR_UNSUPPORTED: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("no helper output")?;
    let mut stderr = child.stderr.take().ok_or("no helper output")?;

    // Readers first: a transcript larger than the pipe buffer would otherwise
    // block the helper while we wait for it to exit.
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
        text
    });

    // The child lives in the job's slot so `asr_cancel` can reach it; a call
    // outside a job gets a slot of its own.
    let slot = running.cloned().unwrap_or_default();
    *slot.lock().map_err(|_| "asr state poisoned")? = Some(child);
    let started = Instant::now();
    let status = loop {
        {
            let mut guard = slot.lock().map_err(|_| "asr state poisoned")?;
            let Some(child) = guard.as_mut() else {
                // Taken by `asr_cancel`, which killed it.
                return Err("cancelled".into());
            };
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                guard.take();
                break status;
            }
            if started.elapsed() > CALL_TIMEOUT {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err("ASR_TIMEOUT: speech recognition stopped responding".into());
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if !status.success() {
        return Err(helper_error(&stderr));
    }
    let line = stdout.lines().last().unwrap_or_default();
    serde_json::from_str(line)
        .map_err(|_| "ASR_INVALID_RESPONSE: the speech helper answered nonsense".into())
}

fn helper_error(stderr: &str) -> String {
    let parsed = stderr
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok());
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "failed".into());
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message")?.as_str().map(str::to_owned))
        .unwrap_or_default();
    format!("ASR_APPLE_{}: {message}", code.to_ascii_uppercase())
}

/// Run the helper while reporting each `{"progress": x}` line — the asset
/// download, which can take a minute.
pub fn run_with_progress(
    arguments: &[String],
    mut progress: impl FnMut(f64),
) -> Result<(), String> {
    use std::io::BufRead;
    let mut child = Command::new(helper_path()?)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ASR_UNSUPPORTED: {error}"))?;
    let mut stderr = child.stderr.take().ok_or("no helper output")?;
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut text);
        text
    });
    if let Some(stdout) = child.stdout.take() {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(fraction) = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|value| value.get("progress")?.as_f64())
            {
                progress(fraction);
            }
        }
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(helper_error(&err.join().unwrap_or_default()))
    }
}

/// `fr-FR`, `en-US`: what a locale argument may look like before it is
/// passed to a process.
pub fn check_locale(locale: &str) -> Result<(), String> {
    // A leading letter: an argument that starts with `--` is a flag.
    let valid = (2..=16).contains(&locale.len())
        && locale.starts_with(|character: char| character.is_ascii_alphabetic())
        && locale
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if valid {
        Ok(())
    } else {
        Err(format!("invalid locale {locale:?}"))
    }
}

pub fn transcribe_arguments(file: &Path, locale: &str, context: &[String]) -> Vec<String> {
    let mut arguments = vec![
        "transcribe".to_string(),
        "--file".into(),
        file.display().to_string(),
        "--locale".into(),
        locale.into(),
    ];
    for term in context {
        arguments.push("--context".into());
        arguments.push(term.clone());
    }
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helper_failure_becomes_a_named_code() {
        assert_eq!(
            helper_error("{\"error\":\"language_not_installed\",\"message\":\"fr-FR\"}\n"),
            "ASR_APPLE_LANGUAGE_NOT_INSTALLED: fr-FR"
        );
        assert_eq!(helper_error("Segmentation fault"), "ASR_APPLE_FAILED: ");
    }

    #[test]
    fn locales_are_held_to_an_identifier_alphabet() {
        for good in ["fr-FR", "en-US", "fr"] {
            assert!(check_locale(good).is_ok(), "{good}");
        }
        for bad in ["", "--file", "fr FR", "../x", &"a".repeat(17)] {
            assert!(check_locale(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn context_terms_are_separate_arguments_never_a_shell_string() {
        let arguments = transcribe_arguments(
            Path::new("/tmp/w0.wav"),
            "fr-FR",
            &["cycle de Calvin".into(), "--file".into()],
        );
        assert_eq!(
            arguments,
            [
                "transcribe", "--file", "/tmp/w0.wav", "--locale", "fr-FR", "--context",
                "cycle de Calvin", "--context", "--file"
            ]
        );
    }
}
