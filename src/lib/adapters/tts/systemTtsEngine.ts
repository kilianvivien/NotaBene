/** macOS system voices through `say(1)` in the Rust bridge. */
import { invoke } from '@tauri-apps/api/core';
import type {
  TtsEngine,
  TtsEngineCapabilities,
  TtsRequest,
  TtsSegmentResult,
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
  async synthesize(): Promise<TtsSegmentResult> {
    throw new Error('text-to-speech requires the desktop app');
  },
};
