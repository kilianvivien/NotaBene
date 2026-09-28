/** Transcription through `src-tauri/src/asr/`. */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppleSpeechStatusSchema } from '@/lib/schema';
import type { AsrAdapter } from './AsrAdapter';
import type { AsrJob } from './AsrEngine';

const INSTALL_PROGRESS_EVENT = 'notabene-asr-install-progress';

/** Rust answers with a string; the pipeline wants an `Error` whose message
 * starts with the code it translates. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export const tauriAsrAdapter: AsrAdapter = {
  supported: () => true,

  prepare: (request) => call<AsrJob>('asr_prepare', { request }),
  cancel: (jobId) => call('asr_cancel', { jobId }),
  release: (jobId) => call('asr_release', { jobId }),

  async appleStatus(locales) {
    const parsed = AppleSpeechStatusSchema.safeParse(
      await call('asr_apple_status', { locales }),
    );
    if (!parsed.success) {
      throw new Error('ASR_INVALID_RESPONSE: the speech helper answered nonsense');
    }
    return parsed.data;
  },

  async appleInstall(locale, onProgress) {
    const unlisten = await listen<{ locale: string; fraction: number }>(
      INSTALL_PROGRESS_EVENT,
      (event) => {
        if (event.payload.locale === locale) onProgress?.(event.payload.fraction);
      },
    );
    try {
      await call('asr_apple_install', { locale });
    } finally {
      unlisten();
    }
  },

  appleDetect: (jobId, locales) => call('asr_apple_detect', { jobId, locales }),
  appleTranscribe: (jobId, index, locale, context) =>
    call('asr_apple_transcribe', { jobId, index, locale, context }),
};
