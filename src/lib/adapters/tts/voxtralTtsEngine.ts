import { Channel, invoke } from '@tauri-apps/api/core';
import { encodeWav } from '@/lib/podcast/wav';
import type {
  TtsAudioEvent,
  TtsEngine,
  TtsEngineCapabilities,
  TtsEngineState,
  TtsRequest,
  TtsSegmentResult,
  TtsStreamRequest,
  TtsVoice,
} from './TtsEngine';

const CAPABILITIES: TtsEngineCapabilities = {
  local: true,
  streaming: true,
  supportsRate: 'playback',
  supportsPitch: false,
  supportsVoiceCloning: false,
  sampleRateHz: 24_000,
  channels: 1,
  formats: ['pcm_s16le', 'wav'],
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Convert a callback-based Tauri channel into a bounded async iterator.
 * Rust emits at most a few seconds of future audio; cancellation also closes
 * the native job when the consumer disappears.
 */
async function* nativeStream(
  request: TtsStreamRequest,
  signal?: AbortSignal,
): AsyncIterable<TtsAudioEvent> {
  const channel = new Channel<TtsAudioEvent>();
  const queue: TtsAudioEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown;
  const maxQueuedEvents = 10;

  channel.onmessage = (event) => {
    if (finished) return;
    if (queue.length >= maxQueuedEvents) {
      failure = new Error('TTS_AUDIO_INVALID: playback receiver fell behind');
      finished = true;
      void invoke('tts_cancel', { requestId: request.requestId });
      wake?.();
      wake = null;
      return;
    }
    queue.push(event);
    if (event.type === 'done' || event.type === 'error') finished = true;
    wake?.();
    wake = null;
  };

  const cancel = () => {
    finished = true;
    void invoke('tts_cancel', { requestId: request.requestId });
    wake?.();
    wake = null;
  };
  signal?.addEventListener('abort', cancel, { once: true });

  void invoke('tts_synthesize_stream', { request, onEvent: channel }).catch((error) => {
    failure = error;
    finished = true;
    wake?.();
    wake = null;
  });

  try {
    while (!finished || queue.length) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const event = queue.shift();
      if (event) {
        yield event;
        if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!finished) cancel();
  }
}

export const voxtralTtsEngine: TtsEngine = {
  id: 'voxtral-local',
  async capabilities() {
    return CAPABILITIES;
  },
  status: () =>
    invoke<TtsEngineState>('tts_engine_status', { engineId: 'voxtral-local' }),
  async isAvailable() {
    const state = await this.status();
    return state.kind === 'ready' || state.kind === 'installed';
  },
  listVoices: () => invoke<TtsVoice[]>('tts_voices', { engineId: 'voxtral-local' }),
  synthesizeStream: nativeStream,
  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsSegmentResult> {
    const requestId = crypto.randomUUID();
    const parts: Uint8Array[] = [];
    let durationMs = 0;
    for await (const event of nativeStream(
      {
        text: request.text,
        voiceId: request.voiceId,
        playbackRate: request.rate,
        requestId,
      },
      signal,
    )) {
      if (event.type === 'audio') parts.push(decodeBase64(event.dataBase64));
      if (event.type === 'done') durationMs = event.durationMs;
    }
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const samples = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.byteLength;
    }
    if (!samples.length) throw new Error('TTS_AUDIO_INVALID: no audio was produced');
    const wav = encodeWav({
      format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
      samples,
    });
    return {
      audio: new Blob([wav], { type: 'audio/wav' }),
      durationMs: durationMs || Math.round((samples.byteLength / 2 / 24_000) * 1000),
      sampleRateHz: 24_000,
      channels: 1,
    };
  },
};

export const voxtralModel = {
  install(acceptedLicense: string): Promise<void> {
    return invoke('tts_model_install', { acceptedLicense });
  },
  cancelInstall(): Promise<void> {
    return invoke('tts_model_cancel_install');
  },
  remove(): Promise<void> {
    return invoke('tts_model_remove');
  },
  shutdown(): Promise<void> {
    return invoke('tts_worker_shutdown');
  },
};
