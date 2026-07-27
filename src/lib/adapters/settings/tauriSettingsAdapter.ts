/** Settings in a JSON file in the app data dir; secrets in the macOS Keychain
 * (falling back to a `0600` file), both owned by the Rust side. */
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, SecretsAdapter, SettingsAdapter } from './SettingsAdapter';

export const tauriSettingsAdapter: SettingsAdapter = {
  load: () => invoke<Partial<AppSettings>>('settings_load'),
  save: (settings: AppSettings) => invoke('settings_save', { settings }),
};

export const tauriSecretsAdapter: SecretsAdapter = {
  get: (key: string) => invoke<string | null>('secrets_get', { key }),
  set: (key: string, value: string) => invoke('secrets_set', { key, value }),
  remove: (key: string) => invoke('secrets_remove', { key }),
  listKeys: () => invoke<string[]>('secrets_list_keys'),
};
