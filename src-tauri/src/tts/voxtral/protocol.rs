use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerCommand {
    Hello {
        protocol_version: u32,
        expected_model_id: String,
        expected_model_revision: String,
        model_directory: String,
    },
    Load,
    Synthesize {
        request_id: String,
        text: String,
        voice_id: String,
        seed: u64,
        chunk_seconds: f32,
    },
    Cancel {
        request_id: String,
    },
    Ping,
    Unload,
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerMessage {
    LoadingProgress {
        #[allow(dead_code)]
        stage: String,
    },
    Ready {
        protocol_version: u32,
        runtime_version: String,
        model_id: String,
        model_revision: String,
        voices: Vec<String>,
        sample_rate_hz: u32,
        loaded: bool,
    },
    Started {
        request_id: String,
        sample_rate_hz: u32,
        channels: u8,
        encoding: String,
    },
    Audio {
        request_id: String,
        sequence: u64,
        #[serde(with = "serde_bytes")]
        pcm: Vec<u8>,
        sample_count: u64,
    },
    GenerationProgress {
        request_id: String,
        generated_samples: u64,
    },
    Cancelled {
        request_id: String,
    },
    Done {
        request_id: String,
        total_samples: u64,
        duration_ms: u64,
    },
    Error {
        request_id: String,
        code: String,
        message: String,
        recoverable: bool,
    },
    Pong {
        #[allow(dead_code)]
        loaded: bool,
    },
    Unloaded,
}

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let payload = rmp_serde::to_vec_named(value).map_err(|error| error.to_string())?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err("TTS_WORKER_PROTOCOL: frame exceeds maximum size".into());
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

#[cfg(test)]
pub fn decode_frame<T: for<'de> Deserialize<'de>>(frame: &[u8]) -> Result<T, String> {
    if frame.len() < 4 {
        return Err("TTS_WORKER_PROTOCOL: truncated frame".into());
    }
    let size = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
    if size > MAX_FRAME_BYTES || frame.len() != size + 4 {
        return Err("TTS_WORKER_PROTOCOL: invalid frame size".into());
    }
    rmp_serde::from_slice(&frame[4..]).map_err(|_| "TTS_WORKER_PROTOCOL: invalid payload".into())
}

pub fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<(), String> {
    let frame = encode_frame(value)?;
    writer
        .write_all(&frame)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("TTS_WORKER_PROTOCOL: {error}"))
}

pub fn read_frame<T: for<'de> Deserialize<'de>>(reader: &mut impl Read) -> Result<T, String> {
    let mut prefix = [0u8; 4];
    reader
        .read_exact(&mut prefix)
        .map_err(|error| format!("TTS_WORKER_CRASHED: {error}"))?;
    let size = u32::from_le_bytes(prefix) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err("TTS_WORKER_PROTOCOL: invalid frame size".into());
    }
    let mut payload = vec![0u8; size];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("TTS_WORKER_CRASHED: {error}"))?;
    rmp_serde::from_slice(&payload).map_err(|_| "TTS_WORKER_PROTOCOL: invalid payload".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_round_trips() {
        let command = WorkerCommand::Cancel {
            request_id: "job-1".into(),
        };
        let frame = encode_frame(&command).unwrap();
        assert_eq!(decode_frame::<WorkerCommand>(&frame).unwrap(), command);
    }

    #[test]
    fn framing_rejects_wrong_length() {
        assert!(decode_frame::<WorkerCommand>(&[9, 0, 0, 0, b'{']).is_err());
    }
}
