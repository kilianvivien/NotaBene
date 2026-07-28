/** Settings and secrets held in memory — tests and the browser dev shell.
 * Secrets deliberately do not persist here: a dev build should never leave an
 * API key lying in browser storage. */
import type { AppSettings, SecretsAdapter, SettingsAdapter } from './SettingsAdapter';

let stored: Partial<AppSettings> = {};

export function resetMemorySettings(): void {
  stored = {};
}

export const memorySettingsAdapter: SettingsAdapter = {
  async load() {
    return { ...stored };
  },
  async save(settings) {
    stored = { ...settings };
  },
};

const secrets = new Map<string, string>();

export const memorySecretsAdapter: SecretsAdapter = {
  async get(key) {
    return secrets.get(key) ?? null;
  },
  async set(key, value) {
    secrets.set(key, value);
  },
  async remove(key) {
    secrets.delete(key);
  },
  async listKeys() {
    return [...secrets.keys()];
  },
};
