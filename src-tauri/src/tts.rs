//! Text-to-speech, over the `say` command.
//!
//! `say(1)` is macOS's own front end to the same speech synthesis the system
//! uses everywhere else, including the premium voices a user has downloaded in
//! System Settings. Driving it costs one process per segment and no new crate;
//! binding `AVSpeechSynthesizer` through `objc2` would buy tighter progress
//! reporting and cost an Objective-C bridge in a codebase that otherwise has
//! none. When Voxtral lands as the second `TtsEngine` it will need real audio
//! plumbing anyway, and that is the moment to pay for it.
//!
//! Nothing here reaches the network. Voices are already on the machine, and
//! synthesis is a local process — which is the point: a student's lecture notes
//! becoming an audio file must not be the one AI feature that quietly uploads
//! the note.
//!
//! Output is 16-bit PCM in a WAVE container, at one fixed sample rate. That is
//! deliberate: the TypeScript side joins segments into one episode by
//! concatenating their samples, which is only sound when every segment shares a
//! format.

use std::process::Command;

#[cfg(target_os = "macos")]
use base64::Engine;
use serde::{Deserialize, Serialize};

/// 22.05 kHz mono. Speech synthesis has nothing above 11 kHz to lose, and the
/// rate halves the size of an episode against 44.1 — which matters when a
/// twelve-minute podcast is being held in the webview as a set of blobs.
#[cfg(any(target_os = "macos", test))]
const SAMPLE_RATE: u32 = 22_050;
#[cfg(target_os = "macos")]
const DATA_FORMAT: &str = "LEI16@22050";

/// Ceiling on one segment. A segment is a few sentences; a `say` that has not
/// returned in this long is wedged, and the podcast panel needs to be told so
/// rather than waiting on it forever.
#[cfg(target_os = "macos")]
const SEGMENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    id: String,
    name: String,
    /// BCP-47. `say` prints `en_US`; the webview and every browser API want
    /// `en-US`, and translating once here means nothing downstream has to know
    /// that `say` is what produced the list.
    locale: String,
    quality: &'static str,
}

/// Mirrors `TtsRequest` in `src/lib/adapters/tts/TtsEngine.ts`. Every field is
/// read only by the macOS path, so a Linux build sees the whole struct as dead.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct TtsRequest {
    text: String,
    voice_id: String,
    /// 1.0 is the voice's natural rate.
    rate: Option<f32>,
    /// Accepted and ignored: `say` exposes no pitch control. The interface
    /// carries it because Voxtral will, and dropping the field from the wire
    /// shape now would mean changing it again later.
    #[allow(dead_code)]
    pitch: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSegment {
    /// Base64 WAVE. Same encoding the asset and export commands use, for the
    /// same reason: Tauri's IPC is JSON, and a byte array crosses it as an
    /// array of numbers costing several times the size.
    data: String,
    mime: &'static str,
    duration_ms: u64,
}

/// Words per minute `say` speaks at when given no `-r`. Used to turn the
/// interface's rate multiplier into the absolute figure `say` wants.
#[cfg(target_os = "macos")]
const BASE_WORDS_PER_MINUTE: f32 = 175.0;

#[tauri::command]
pub fn tts_system_available() -> bool {
    cfg!(target_os = "macos")
        && Command::new("/usr/bin/say")
            .arg("-v")
            .arg("?")
            .output()
            .is_ok_and(|output| output.status.success())
}

/// Parse `say -v '?'`, whose lines look like:
/// `Alex                en_US    # Most people recognize me by my voice.`
///
/// Names can contain spaces (`Eddy (English (UK))`), so the split is on the
/// locale token rather than on whitespace — the locale is the first field that
/// matches `xx_YY`, and everything before it is the name.
fn parse_voices(listing: &str) -> Vec<TtsVoice> {
    let mut voices = Vec::new();

    for line in listing.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some((head, _comment)) = line.split_once('#') else {
            continue;
        };
        let mut fields = head.split_whitespace().collect::<Vec<_>>();
        let Some(locale) = fields.pop() else {
            continue;
        };
        if !locale.contains('_') && !locale.contains('-') {
            continue;
        }
        let name = fields.join(" ");
        if name.is_empty() {
            continue;
        }

        // Voice quality is not in the listing. The name is the only signal
        // macOS gives, and it gives it reliably: downloaded voices are listed
        // with the tier in parentheses.
        let quality = if name.contains("(Premium)") {
            "premium"
        } else if name.contains("(Enhanced)") {
            "enhanced"
        } else {
            "standard"
        };

        voices.push(TtsVoice {
            id: name.clone(),
            name,
            locale: locale.replace('_', "-"),
            quality,
        });
    }

    voices
}

#[tauri::command]
pub fn tts_system_voices() -> Result<Vec<TtsVoice>, String> {
    if !cfg!(target_os = "macos") {
        return Err("system speech is only available on macOS".into());
    }
    let output = Command::new("/usr/bin/say")
        .arg("-v")
        .arg("?")
        .output()
        .map_err(|error| format!("could not run say: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(parse_voices(&String::from_utf8_lossy(&output.stdout)))
}

/// Duration from the WAVE header, rather than from a word count.
///
/// The player seeks with these numbers, so an estimate would put the highlight
/// on the wrong segment within about a minute. `data` is found by walking the
/// chunk list because macOS writes a `LIST` chunk of its own ahead of it.
#[cfg(any(target_os = "macos", test))]
fn duration_ms(wav: &[u8]) -> u64 {
    let mut offset = 12usize;
    while offset + 8 <= wav.len() {
        let id = &wav[offset..offset + 4];
        let size = u32::from_le_bytes([
            wav[offset + 4],
            wav[offset + 5],
            wav[offset + 6],
            wav[offset + 7],
        ]) as usize;
        if id == b"data" {
            let bytes = size.min(wav.len().saturating_sub(offset + 8));
            // 16-bit mono at SAMPLE_RATE: two bytes per frame.
            return (bytes as u64 * 1000) / (SAMPLE_RATE as u64 * 2);
        }
        offset = offset + 8 + size + (size % 2);
    }
    0
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn tts_system_synthesize(request: TtsRequest) -> Result<TtsSegment, String> {
    if request.text.trim().is_empty() {
        return Err("nothing to say".into());
    }

    // A temporary file rather than a pipe: `say` will not write audio to
    // stdout, and a named output is also what lets it choose the container.
    let path = std::env::temp_dir().join(format!("notabene-tts-{}.wav", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let mut command = Command::new("/usr/bin/say");
    command
        .arg("-v")
        .arg(&request.voice_id)
        .arg("--data-format")
        .arg(DATA_FORMAT)
        .arg("--file-format")
        .arg("WAVE")
        .arg("-o")
        .arg(&path);

    if let Some(rate) = request.rate {
        if rate > 0.0 {
            command
                .arg("-r")
                .arg(format!("{:.0}", BASE_WORDS_PER_MINUTE * rate));
        }
    }

    // The text goes in on stdin. As an argument it would be subject to the
    // command-line length limit, and a note's paragraph is easily long enough
    // to matter — and a leading `-` in the text would be read as a flag.
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("could not run say: {error}"))?;
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().ok_or("say refused stdin")?;
        stdin
            .write_all(request.text.as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if started.elapsed() > SEGMENT_TIMEOUT => {
                let _ = child.kill();
                let _ = std::fs::remove_file(&path);
                return Err("speech synthesis timed out".into());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(40)),
        }
    };

    if !status.success() {
        use std::io::Read;
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        let _ = std::fs::remove_file(&path);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("say exited with {status}")
        } else {
            detail.to_string()
        });
    }

    let bytes = std::fs::read(&path).map_err(|error| format!("no audio was produced: {error}"))?;
    let _ = std::fs::remove_file(&path);
    if bytes.len() <= 44 {
        return Err("the voice produced no audio".into());
    }

    Ok(TtsSegment {
        duration_ms: duration_ms(&bytes),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: "audio/wav",
    })
}

/// Everywhere that is not macOS. Named rather than silent, per the house rule:
/// a feature that cannot work here should say why, not return empty audio the
/// player would show as a zero-second episode.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn tts_system_synthesize(_request: TtsRequest) -> Result<TtsSegment, String> {
    Err("system speech is only available on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_with_spaces_and_normalises_the_locale() {
        let listing = "\
Alex                en_US    # Most people recognize me by my voice.
Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
Thomas              fr_FR    # Bonjour, je m'appelle Thomas.
";
        let voices = parse_voices(listing);
        assert_eq!(voices.len(), 3);
        assert_eq!(voices[1].name, "Eddy (English (UK))");
        assert_eq!(voices[1].locale, "en-GB");
        assert_eq!(voices[2].locale, "fr-FR");
    }

    #[test]
    fn skips_lines_that_are_not_voices() {
        assert!(parse_voices("some preamble without a comment\n\n").is_empty());
    }

    #[test]
    fn marks_downloaded_voice_tiers() {
        let voices = parse_voices("Ava (Premium)  en_US  # Hello.\nZoe (Enhanced) en_US  # Hi.\n");
        assert_eq!(voices[0].quality, "premium");
        assert_eq!(voices[1].quality, "enhanced");
    }

    #[test]
    fn duration_walks_past_a_list_chunk() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&0u32.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"LIST");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(b"INFO");
        wav.extend_from_slice(b"data");
        // One second: 22050 frames at two bytes each.
        let bytes = SAMPLE_RATE as usize * 2;
        wav.extend_from_slice(&(bytes as u32).to_le_bytes());
        wav.extend(std::iter::repeat_n(0u8, bytes));
        assert_eq!(duration_ms(&wav), 1000);
    }
}
