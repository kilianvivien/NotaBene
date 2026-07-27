/**
 * App settings and secrets.
 *
 * Split into two interfaces on purpose. Settings are ordinary JSON that belongs
 * in exports and diagnostics; secrets are API keys that must never reach a
 * backup, an export, or `localStorage` (PRD §8, DiploRevue lesson). Different
 * storage, different lifetime, different blast radius — so, different type.
 */
export type AccentColor = 'orange' | 'blue' | 'purple' | 'pink' | 'green' | 'graphite';

export interface AiProviderSettings {
  /** Only meaningful for providers that need no key. Pasting a key is itself
   * an opt-in; a local runtime has no equivalent gesture, and without one the
   * app would silently resolve to an Ollama that may not be installed instead
   * of saying "connect a provider". */
  enabled?: boolean;
  /** Overrides the catalogue's default; the only field a self-hosted or
   * proxied endpoint needs. `null` means "use the built-in address". */
  baseUrl: string | null;
  /** Model ids the user typed that the catalogue does not list. A baked-in
   * catalogue goes stale between releases; this is how it keeps up. */
  extraModels: string[];
}

export interface PodcastSettings {
  /** A macOS voice id, or `null` until the user has picked one — the installed
   * voices differ per machine, so there is no default worth baking in. */
  voiceId: string | null;
  /** Multiplier on the voice's natural rate. */
  rate: number;
  mode: 'narrator' | 'dialogue';
  /** Target episode length, in minutes. */
  minutes: number;
}

export interface AppSettings {
  locale: 'en' | 'fr';
  theme: 'light' | 'dark' | 'system';
  accentColor: AccentColor;
  editorFont: 'sans' | 'avenir' | 'serif' | 'claude' | 'iowan' | 'mono';
  editorFontSize: number;
  editorTitleSize: number;
  focusMode: boolean;
  /** Trash retention, in days. */
  trashRetentionDays: number;
  /** How aggressively old per-note versions are thinned. */
  snapshotRetention: 'standard' | 'extended' | 'forever';
  backupSchedule: 'off' | 'daily' | 'weekly';
  backupFolder: string | null;
  lastBackupAt: string | null;
  exportPreset: {
    format: 'markdown' | 'html' | 'pdf' | 'docx';
    layout: 'combined' | 'separate';
    includeToc: boolean;
  };
  /** Provider id per AI feature, so synthesis can use a stronger model than
   * spell-fixing without the user re-picking every time. The `default` entry is
   * what every unlisted feature resolves through. */
  aiFeatureModels: Record<string, { providerId: string; model: string }>;
  /** Per-provider configuration that is *not* a secret. Keys live in the
   * Keychain and have no representation here — see the schema note in §1.6. */
  aiProviders: Record<string, AiProviderSettings>;
  /** Remembered between episodes, because picking a voice from a list of forty
   * is not something anyone wants to do twice. */
  podcast: PodcastSettings;
  mcpEnabled: boolean;
  mcpPort: number;
  checkForUpdates: boolean;
  /** Sort choice per stable view key (`all`, `course:<id>`, …). */
  viewSorts: Record<string, 'updated' | 'created' | 'title' | 'manual' | 'relevance'>;
  recentSearches: string[];
}

export interface SettingsAdapter {
  load(): Promise<Partial<AppSettings>>;
  save(settings: AppSettings): Promise<void>;
}

/**
 * Secrets live in the macOS Keychain when available, and otherwise in a
 * `0600` file in the app data dir. Values are addressed by provider id.
 */
export interface SecretsAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Key names only — never values. Lets Settings show which providers are
   * configured without pulling secrets into the webview. */
  listKeys(): Promise<string[]>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'en',
  theme: 'system',
  accentColor: 'orange',
  editorFont: 'sans',
  editorFontSize: 16,
  editorTitleSize: 40,
  focusMode: false,
  trashRetentionDays: 30,
  snapshotRetention: 'standard',
  backupSchedule: 'off',
  backupFolder: null,
  lastBackupAt: null,
  exportPreset: {
    format: 'pdf',
    layout: 'combined',
    includeToc: true,
  },
  aiFeatureModels: {},
  aiProviders: {},
  podcast: { voiceId: null, rate: 1, mode: 'narrator', minutes: 6 },
  mcpEnabled: false,
  mcpPort: 22600,
  checkForUpdates: true,
  viewSorts: {},
  recentSearches: [],
};
