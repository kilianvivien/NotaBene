/** The browser shell has no Rust to decode audio and no Apple recogniser.
 * Every call fails loudly; `supported()` is what keeps the command disabled
 * so the student never reaches one. */
import type { AsrAdapter } from './AsrAdapter';

const refuse = () =>
  Promise.reject(new Error('ASR_UNSUPPORTED: transcription needs the desktop app'));

export const unavailableAsrAdapter: AsrAdapter = {
  supported: () => false,
  prepare: refuse,
  cancel: () => Promise.resolve(),
  release: () => Promise.resolve(),
  appleStatus: () =>
    Promise.resolve({ available: false, reason: 'unsupported_shell', languages: [] }),
  appleInstall: refuse,
  appleDetect: refuse,
  appleTranscribe: refuse,
};
