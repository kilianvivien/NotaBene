/** macOS system voices through the Swift `AVSpeechSynthesizer` bridge. */
import { invoke } from '@tauri-apps/api/core';
import type { TtsEngine, TtsRequest, TtsSegmentResult, TtsVoice } from './TtsEngine';

export const systemTtsEngine: TtsEngine = {
  id: 'system',

  isAvailable: () => invoke<boolean>('tts_system_available'),
  listVoices: () => invoke<TtsVoice[]>('tts_system_voices'),

  /**
   * Cancellation is checked on the way in and no further.
   *
   * `invoke` has no abort channel, and `say` is a subprocess that will finish
   * the sentence it is on whatever the webview thinks. The granularity that
   * matters is the segment, and the podcast command loop checks the signal
   * between segments — so a cancel costs at most a few seconds of speech
   * nobody will hear, rather than the rest of the episode.
   */
  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsSegmentResult> {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
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
