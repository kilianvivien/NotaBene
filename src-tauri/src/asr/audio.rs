//! Lecture audio for transcription: decode, read by window, plan the windows.
//!
//! Decoding is macOS's own `afconvert`, as speech synthesis is `say(1)`: no
//! codec crate, and no codec code of ours parsing untrusted audio in-process.
//! Whatever the student dropped — the AAC-in-MP4 NotaBene records, an M4A or
//! MP3 from a phone, a WAV — becomes one 16-bit, 16 kHz mono WAV in the job
//! directory, about 115 MB an hour. Windows are then read from it by offset,
//! so memory is bounded by a window, never by the lecture.
//!
//! **Two sample rates live in this app** (plan trap T13). Speech synthesis
//! writes 22.05 kHz for `src/lib/podcast/wav.ts`; this is 16 kHz for speech
//! recognition. Nothing here may be shared with that path.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::Command;

pub const SAMPLE_RATE: u32 = 16_000;
const BYTES_PER_SAMPLE: u64 = 2;

/// Ten hours. A decoded file past this is not a lecture, and refusing it
/// keeps a hostile or broken file from filling the disk at 115 MB an hour.
pub const MAX_DURATION_MS: u64 = 10 * 60 * 60 * 1000;

/// Energy is measured in frames of this length for the window planner.
pub const FRAME_MS: u64 = 100;
const FRAME_SAMPLES: usize = (SAMPLE_RATE as u64 * FRAME_MS / 1000) as usize;

/// A cut is looked for this far before the nominal window end — the longest
/// pause in the last fifteen seconds is where a sentence most likely ended.
pub const CUT_SEARCH_MS: u64 = 15_000;

/// Below this RMS (about −40 dBFS) a frame is treated as silence.
const SILENCE_RMS: f32 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Where the PCM samples sit in a WAV file.
#[derive(Debug, Clone, Copy)]
pub struct PcmLayout {
    pub data_offset: u64,
    pub samples: u64,
}

impl PcmLayout {
    pub fn duration_ms(&self) -> u64 {
        self.samples * 1000 / SAMPLE_RATE as u64
    }
}

/// `afconvert -f WAVE -d LEI16@16000 -c 1`. Blocking: call it inside
/// `spawn_blocking`.
pub fn decode_to_wav(input: &Path, output: &Path) -> Result<(), String> {
    let result = Command::new("/usr/bin/afconvert")
        .args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1"])
        .arg(input)
        .arg(output)
        .output()
        .map_err(|error| format!("ASR_AUDIO_UNSUPPORTED: {error}"))?;
    if !result.status.success() {
        // afconvert's own words are English and technical; the code is what
        // the webview translates.
        return Err("ASR_AUDIO_UNSUPPORTED: this audio could not be decoded".into());
    }
    Ok(())
}

/// Hosted engines receive AAC rather than PCM: a ten-minute window is about
/// 2.4 MB at 32 kb/s instead of 19 MB.
pub fn encode_aac(input: &Path, output: &Path) -> Result<(), String> {
    let result = Command::new("/usr/bin/afconvert")
        .args(["-f", "m4af", "-d", "aac", "-b", "32000", "-c", "1"])
        .arg(input)
        .arg(output)
        .output()
        .map_err(|error| format!("ASR_AUDIO_UNSUPPORTED: {error}"))?;
    if !result.status.success() {
        return Err("ASR_AUDIO_UNSUPPORTED: the window could not be encoded".into());
    }
    Ok(())
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

/// Walk the RIFF chunks for `fmt ` and `data`. afconvert may add others
/// (`FLLR` padding), so the data offset is found, never assumed to be 44.
pub fn pcm_layout(path: &Path) -> Result<PcmLayout, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| "ASR_AUDIO_UNSUPPORTED: not a WAV file".to_string())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("ASR_AUDIO_UNSUPPORTED: not a WAV file".into());
    }
    let mut position = 12_u64;
    let mut format_ok = false;
    while position + 8 <= length {
        let mut chunk = [0_u8; 8];
        file.seek(SeekFrom::Start(position))
            .and_then(|_| file.read_exact(&mut chunk))
            .map_err(|error| error.to_string())?;
        let size = read_u32(&chunk[4..8]) as u64;
        let body = position + 8;
        match &chunk[0..4] {
            b"fmt " => {
                let mut format = [0_u8; 16];
                file.read_exact(&mut format)
                    .map_err(|error| error.to_string())?;
                let pcm = read_u16(&format[0..2]) == 1;
                let channels = read_u16(&format[2..4]);
                let rate = read_u32(&format[4..8]);
                let bits = read_u16(&format[14..16]);
                format_ok = pcm && channels == 1 && rate == SAMPLE_RATE && bits == 16;
            }
            b"data" => {
                if !format_ok {
                    return Err("ASR_AUDIO_UNSUPPORTED: unexpected PCM format".into());
                }
                // A header can claim more than the file holds; trust the file.
                let size = size.min(length - body);
                return Ok(PcmLayout {
                    data_offset: body,
                    samples: size / BYTES_PER_SAMPLE,
                });
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        position = body + size + (size & 1);
    }
    Err("ASR_AUDIO_UNSUPPORTED: the WAV file has no audio".into())
}

pub fn write_wav_header(out: &mut impl Write, samples: u64) -> std::io::Result<()> {
    let data = (samples * BYTES_PER_SAMPLE) as u32;
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16_u32.to_le_bytes())?;
    out.write_all(&1_u16.to_le_bytes())?;
    out.write_all(&1_u16.to_le_bytes())?;
    out.write_all(&SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?;
    out.write_all(&2_u16.to_le_bytes())?;
    out.write_all(&16_u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data.to_le_bytes())?;
    Ok(())
}

fn ms_to_samples(ms: u64) -> u64 {
    ms * SAMPLE_RATE as u64 / 1000
}

/// Copy one window of the decoded lecture into a WAV of its own.
pub fn write_window(
    source: &Path,
    layout: PcmLayout,
    window: Window,
    target: &Path,
) -> Result<(), String> {
    let first = ms_to_samples(window.start_ms).min(layout.samples);
    let last = ms_to_samples(window.end_ms).min(layout.samples);
    let samples = last.saturating_sub(first);
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    input
        .seek(SeekFrom::Start(layout.data_offset + first * BYTES_PER_SAMPLE))
        .map_err(|error| error.to_string())?;
    let mut output = std::io::BufWriter::new(File::create(target).map_err(|error| error.to_string())?);
    write_wav_header(&mut output, samples).map_err(|error| error.to_string())?;
    std::io::copy(
        &mut input.take(samples * BYTES_PER_SAMPLE),
        &mut output,
    )
    .map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

/// RMS per `FRAME_MS` frame, streamed — a ten-hour file is 36 000 frames, not
/// a gigabyte in memory.
pub fn frame_energy(source: &Path, layout: PcmLayout) -> Result<Vec<f32>, String> {
    let mut input = BufReader::new(File::open(source).map_err(|error| error.to_string())?);
    input
        .seek(SeekFrom::Start(layout.data_offset))
        .map_err(|error| error.to_string())?;
    let mut remaining = layout.samples;
    let mut frames = Vec::with_capacity((layout.samples as usize / FRAME_SAMPLES) + 1);
    let mut buffer = vec![0_u8; FRAME_SAMPLES * 2];
    while remaining > 0 {
        let take = (remaining as usize).min(FRAME_SAMPLES);
        input
            .read_exact(&mut buffer[..take * 2])
            .map_err(|error| error.to_string())?;
        let sum: f64 = buffer[..take * 2]
            .chunks_exact(2)
            .map(|pair| {
                let value = i16::from_le_bytes([pair[0], pair[1]]) as f64 / 32768.0;
                value * value
            })
            .sum();
        frames.push((sum / take as f64).sqrt() as f32);
        remaining -= take as u64;
    }
    Ok(frames)
}

/// Where speech starts: the first run of three loud frames. A lecture often
/// opens on a minute of a room settling, and a language probe of silence
/// decides nothing.
pub fn speech_start_ms(frames: &[f32]) -> u64 {
    frames
        .windows(3)
        .position(|run| run.iter().all(|&rms| rms > SILENCE_RMS))
        .map(|index| index as u64 * FRAME_MS)
        .unwrap_or(0)
}

/// Cut the lecture into windows of at most `window_ms`, overlapping by
/// `overlap_ms`, each cut placed in the quietest half-second of the last
/// `CUT_SEARCH_MS` before the nominal end.
///
/// Window *k* is `[start_k, cut_k + overlap]` and window *k+1* starts at
/// `cut_k`, so the overlap is `[cut_k, cut_k + overlap]` and a window never
/// exceeds `window_ms`. The stitcher keeps each side of the overlap's
/// midpoint (`src/lib/transcript/stitch.ts`).
pub fn plan_windows(frames: &[f32], window_ms: u64, overlap_ms: u64) -> Vec<Window> {
    let duration = frames.len() as u64 * FRAME_MS;
    let mut windows = Vec::new();
    if duration == 0 {
        return windows;
    }
    let step = window_ms.saturating_sub(overlap_ms).max(FRAME_MS);
    let mut start = 0_u64;
    loop {
        if start + window_ms >= duration {
            windows.push(Window {
                start_ms: start,
                end_ms: duration,
            });
            return windows;
        }
        let latest = start + step;
        let earliest = latest.saturating_sub(CUT_SEARCH_MS).max(start + FRAME_MS);
        let cut = quietest(frames, earliest, latest);
        windows.push(Window {
            start_ms: start,
            end_ms: (cut + overlap_ms).min(duration),
        });
        start = cut;
    }
}

/// The frame boundary in `[earliest, latest]` with the lowest energy over the
/// half second around it; the latest one wins a tie, so windows stay long.
fn quietest(frames: &[f32], earliest: u64, latest: u64) -> u64 {
    const SPAN: usize = 5; // 500 ms
    let first = (earliest / FRAME_MS) as usize;
    let last = ((latest / FRAME_MS) as usize).min(frames.len());
    let mut best = (f32::INFINITY, latest);
    for boundary in first..=last {
        let from = boundary.saturating_sub(SPAN / 2);
        let to = (boundary + SPAN / 2 + 1).min(frames.len());
        if from >= to {
            continue;
        }
        let mean = frames[from..to].iter().sum::<f32>() / (to - from) as f32;
        if mean <= best.0 {
            best = (mean, boundary as u64 * FRAME_MS);
        }
    }
    best.1
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(std::path::PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(label: &str) -> TempDir {
        let path = std::env::temp_dir().join(format!(
            "notabene-asr-audio-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    /// A 16 kHz mono WAV of `samples`, written with our own header.
    fn wav_of(path: &Path, samples: &[i16]) {
        let mut file = File::create(path).unwrap();
        write_wav_header(&mut file, samples.len() as u64).unwrap();
        for sample in samples {
            file.write_all(&sample.to_le_bytes()).unwrap();
        }
    }

    #[test]
    fn a_wav_we_wrote_is_read_back_at_its_data_offset() {
        let dir = temp_dir("layout");
        let path = dir.0.join("a.wav");
        wav_of(&path, &[1, 2, 3, 4]);
        let layout = pcm_layout(&path).unwrap();
        assert_eq!(layout.data_offset, 44);
        assert_eq!(layout.samples, 4);
    }

    #[test]
    fn a_window_read_by_offset_is_that_span_of_samples() {
        let dir = temp_dir("window");
        let path = dir.0.join("a.wav");
        let samples: Vec<i16> = (0..32_000).map(|index| (index % 1000) as i16).collect();
        wav_of(&path, &samples);
        let layout = pcm_layout(&path).unwrap();
        let target = dir.0.join("w.wav");
        write_window(
            &path,
            layout,
            Window {
                start_ms: 500,
                end_ms: 1_500,
            },
            &target,
        )
        .unwrap();
        let window = pcm_layout(&target).unwrap();
        assert_eq!(window.samples, 16_000);
        let bytes = std::fs::read(&target).unwrap();
        let first = i16::from_le_bytes([bytes[44], bytes[45]]);
        assert_eq!(first, samples[8_000]);
    }

    #[test]
    fn frames_carry_the_loudness_of_their_tenth_of_a_second() {
        let dir = temp_dir("energy");
        let path = dir.0.join("a.wav");
        let mut samples = vec![0_i16; 1_600];
        samples.extend(std::iter::repeat_n(16_384_i16, 1_600));
        wav_of(&path, &samples);
        let frames = frame_energy(&path, pcm_layout(&path).unwrap()).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], 0.0);
        assert!((frames[1] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn speech_starts_at_the_first_sustained_sound() {
        let mut frames = vec![0.0; 50];
        frames[10] = 0.5; // a door, not a lecturer
        frames.extend([0.2; 20]);
        assert_eq!(speech_start_ms(&frames), 5_000);
        assert_eq!(speech_start_ms(&[0.0; 10]), 0);
    }

    #[test]
    fn a_short_recording_is_one_window() {
        let frames = vec![0.1; 600]; // 60 s
        assert_eq!(
            plan_windows(&frames, 240_000, 3_000),
            vec![Window {
                start_ms: 0,
                end_ms: 60_000
            }]
        );
        assert!(plan_windows(&[], 240_000, 3_000).is_empty());
    }

    #[test]
    fn windows_are_cut_in_the_pause_and_overlap_by_the_margin() {
        // Ten minutes of speech with one pause at 3:50.
        let mut frames = vec![0.2; 6_000];
        for frame in &mut frames[2_295..2_305] {
            *frame = 0.0;
        }
        let windows = plan_windows(&frames, 240_000, 3_000);
        assert_eq!(windows[0].start_ms, 0);
        let cut = windows[1].start_ms;
        assert!((229_500..=230_500).contains(&cut), "cut at {cut}");
        assert_eq!(windows[0].end_ms, cut + 3_000);
        for window in &windows {
            assert!(window.end_ms - window.start_ms <= 240_000, "{window:?}");
        }
        assert_eq!(windows.last().unwrap().end_ms, 600_000);
        for pair in windows.windows(2) {
            assert!(pair[1].start_ms < pair[0].end_ms, "windows overlap");
        }
    }

    #[test]
    fn with_no_pause_the_cut_falls_at_the_nominal_end() {
        let frames = vec![0.2; 6_000];
        let windows = plan_windows(&frames, 240_000, 3_000);
        assert_eq!(windows[0].end_ms, 240_000);
        assert_eq!(windows[1].start_ms, 237_000);
    }

    /// The decoder is judged on a tone, not trusted: a 1 kHz sine at 44.1 kHz
    /// stereo must come out as 16 000 samples a second, crossing zero where a
    /// 1 kHz tone does.
    #[cfg(target_os = "macos")]
    #[test]
    fn afconvert_resamples_a_stereo_tone_to_16_khz_mono() {
        let dir = temp_dir("tone");
        let source = dir.0.join("tone.wav");
        {
            let rate = 44_100_u32;
            let seconds = 2_u32;
            let frames = rate * seconds;
            let mut file = File::create(&source).unwrap();
            let data = frames * 4;
            file.write_all(b"RIFF").unwrap();
            file.write_all(&(36 + data).to_le_bytes()).unwrap();
            file.write_all(b"WAVEfmt ").unwrap();
            file.write_all(&16_u32.to_le_bytes()).unwrap();
            file.write_all(&1_u16.to_le_bytes()).unwrap();
            file.write_all(&2_u16.to_le_bytes()).unwrap();
            file.write_all(&rate.to_le_bytes()).unwrap();
            file.write_all(&(rate * 4).to_le_bytes()).unwrap();
            file.write_all(&4_u16.to_le_bytes()).unwrap();
            file.write_all(&16_u16.to_le_bytes()).unwrap();
            file.write_all(b"data").unwrap();
            file.write_all(&data.to_le_bytes()).unwrap();
            for index in 0..frames {
                let value = ((index as f64 * 1000.0 * std::f64::consts::TAU / rate as f64).sin()
                    * 12_000.0) as i16;
                file.write_all(&value.to_le_bytes()).unwrap();
                file.write_all(&value.to_le_bytes()).unwrap();
            }
        }
        let decoded = dir.0.join("decoded.wav");
        decode_to_wav(&source, &decoded).unwrap();
        let layout = pcm_layout(&decoded).unwrap();
        assert!(
            (layout.samples as i64 - 32_000).abs() <= 32,
            "{} samples",
            layout.samples
        );

        let bytes = std::fs::read(&decoded).unwrap();
        let start = layout.data_offset as usize;
        let samples: Vec<i16> = bytes[start..]
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        // Skip the resampler's settling at either end.
        let middle = &samples[1_600..samples.len() - 1_600];
        let crossings = middle
            .windows(2)
            .filter(|pair| (pair[0] < 0) != (pair[1] < 0))
            .count();
        let seconds = middle.len() as f64 / 16_000.0;
        let per_second = crossings as f64 / seconds;
        assert!((per_second - 2_000.0).abs() < 20.0, "{per_second} crossings/s");
    }
}
