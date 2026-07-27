/**
 * App settings and secrets.
 *
 * Split into two interfaces on purpose. Settings are ordinary JSON that belongs
 * in exports and diagnostics; secrets are API keys that must never reach a
 * backup, an export, or `localStorage` (PRD §8, DiploRevue lesson). Different
 * storage, different lifetime, different blast radius — so, different type.
 */
export type AccentColor = 'orange' | 'blue' | 'purple' | 'pink' | 'green' | 'graphite';

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
  backupSchedule: 'off' | 'daily' | 'weekly';
  backupFolder: string | null;
  /** Provider id per AI feature, so synthesis can use a stronger model than
   * spell-fixing without the user re-picking every time. */
  aiFeatureModels: Record<string, { providerId: string; model: string }>;
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
  backupSchedule: 'off',
  backupFolder: null,
  aiFeatureModels: {},
  mcpEnabled: false,
  mcpPort: 22600,
  checkForUpdates: true,
  viewSorts: {},
  recentSearches: [],
};
