/** macOS system voices through `say(1)` in the Rust bridge. */
import { invoke } from '@tauri-apps/api/core';
import type {
  TtsAudioEvent,
  TtsEngine,
  TtsEngineCapabilities,
  TtsRequest,
  TtsSegmentResult,
  TtsStreamRequest,
  TtsVoice,
} from './TtsEngine';

const CAPABILITIES: TtsEngineCapabilities = {
  local: true,
  streaming: false,
  supportsRate: 'synthesis',
  supportsPitch: false,
  supportsVoiceCloning: false,
  sampleRateHz: 22_050,
  channels: 1,
  formats: ['wav'],
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

export const systemTtsEngine: TtsEngine = {
  id: 'system',

  async capabilities() {
    return CAPABILITIES;
  },
  async status() {
    return (await invoke<boolean>('tts_system_available'))
      ? ({ kind: 'ready' } as const)
      : ({
          kind: 'unsupported',
          code: 'TTS_UNSUPPORTED_OS',
          reason: 'System speech is unavailable.',
        } as const);
  },
  isAvailable: () => invoke<boolean>('tts_system_available'),
  listVoices: () => invoke<TtsVoice[]>('tts_system_voices'),

  async *synthesizeStream(
    request: TtsStreamRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TtsAudioEvent> {
    const result = await this.synthesize(
      {
        text: request.text,
        voiceId: request.voiceId,
        rate: request.playbackRate,
      },
      signal,
    );
    const bytes = new Uint8Array(await result.audio.arrayBuffer());
    const totalSamples = Math.round((result.durationMs / 1000) * 22_050);
    yield {
      type: 'started',
      requestId: request.requestId,
      sampleRateHz: 22_050,
      channels: 1,
      encoding: 'wav',
    };
    yield {
      type: 'audio',
      requestId: request.requestId,
      sequence: 0,
      dataBase64: bytesToBase64(bytes),
      sampleCount: totalSamples,
    };
    yield {
      type: 'done',
      requestId: request.requestId,
      totalSamples,
      durationMs: result.durationMs,
    };
  },

  /**
   * `invoke` has no abort channel for `say`; cancellation is therefore checked
   * before and after a segment. The command loop checks again between segments.
   */
  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsSegmentResult> {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const result = await invoke<{ data: string; mime: string; durationMs: number }>(
      'tts_system_synthesize',
      { request },
    );
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return {
      audio: new Blob([bytes], { type: result.mime }),
      durationMs: result.durationMs,
      sampleRateHz: 22_050,
      channels: 1,
    };
  },
};

/** Stand-in for the browser dev shell, where no native bridge exists. */
export const unavailableTtsEngine: TtsEngine = {
  id: 'system',
  async capabilities() {
    return CAPABILITIES;
  },
  async status() {
    return {
      kind: 'unsupported',
      code: 'TTS_UNSUPPORTED_OS',
      reason: 'Text-to-speech requires the desktop app.',
    };
  },
  async isAvailable() {
    return false;
  },
  async listVoices() {
    return [];
  },
  async *synthesizeStream(request): AsyncIterable<TtsAudioEvent> {
    yield {
      type: 'error',
      requestId: request.requestId,
      code: 'TTS_UNSUPPORTED_OS',
      message: 'text-to-speech requires the desktop app',
      recoverable: false,
    };
  },
  async synthesize(): Promise<TtsSegmentResult> {
    throw new Error('text-to-speech requires the desktop app');
  },
};
