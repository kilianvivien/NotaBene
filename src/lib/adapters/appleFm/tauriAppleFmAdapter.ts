import { invoke } from '@tauri-apps/api/core';
import type { AppleFmAdapter, AppleFmPreflight, AppleFmStatus } from './AppleFmAdapter';

export const tauriAppleFmAdapter: AppleFmAdapter = {
  preflight: () => invoke<AppleFmPreflight>('apple_fm_preflight'),
  start: (port) => invoke<number>('apple_fm_start', { port }),
  stop: () => invoke('apple_fm_stop'),
  status: () => invoke<AppleFmStatus>('apple_fm_status'),
  countTokens: (text) => invoke<number>('apple_fm_count_tokens', { text }),
};
