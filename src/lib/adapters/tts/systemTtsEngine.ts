/** macOS system voices through the Swift `AVSpeechSynthesizer` bridge. */
import { invoke } from '@tauri-apps/api/core';
import type { TtsEngine, TtsRequest, TtsSegmentResult, TtsVoice } from './TtsEngine';

export const systemTtsEngine: TtsEngine = {
  id: 'system',

  isAvailable: () => invoke<boolean>('tts_system_available'),
  listVoices: () => invoke<TtsVoice[]>('tts_system_voices'),

  async synthesize(request: TtsRequest): Promise<TtsSegmentResult> {
    const result = await invoke<{ data: string; mime: string; durationMs: number }>(
      'tts_system_synthesize',
      { request },
    );
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return {
      audio: new Blob([bytes], { type: result.mime }),
      durationMs: result.durationMs,
    };
  },
};

/** Stand-in for the browser dev shell, where no native bridge exists. */
export const unavailableTtsEngine: TtsEngine = {
  id: 'system',
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
