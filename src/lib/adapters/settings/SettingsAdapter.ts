import type { TtsEngineId } from '../tts/TtsEngine';

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

export interface SpeechSettings {
  engineId: TtsEngineId;
  /** Voice ids belong to an engine and are never interchangeable. */
  voicesByEngine: Partial<Record<TtsEngineId, string>>;
  /** Exact managed revisions prove that a local selection belongs to this
   * implementation. An older abandoned `voxtral-local` preference has no
   * marker and safely migrates back to system speech. */
  localModelRevisions: Partial<Record<'voxtral-local' | 'kokoro-local', string>>;
  /** Player speed; the hosted API synthesizes at its natural rate. */
  playbackRate: number;
  /** A saved, explicit fallback to system speech. Never resolves to cloud. */
  fallbackToSystem: boolean;
}

/**
 * A typing shortcut: type `trigger`, finish the word, get `expansion`.
 *
 * Both halves are plain text on purpose. An expansion that could carry marks or
 * blocks would be a second authoring surface to build, review and export, and
 * the thing a student actually wants here is "→" for "->" and the full name of
 * a theorem they type forty times a term.
 */
export interface Abbreviation {
  /** Stable across edits so a row keeps its identity while its trigger is
   * being retyped — React keys, and nothing else, depend on this. */
  id: string;
  trigger: string;
  expansion: string;
}

/**
 * Concentration mode's character.
 *
 * These describe the *mode*, not the app: nothing here changes how a note looks
 * while you are browsing the library. The defaults are deliberately the
 * opinionated ones — the mode is itself opt-in, so someone who turns it on is
 * asking for the typewriter, not for the same page with fewer panes.
 */
export interface FocusSettings {
  /** `app` keeps the ordinary reading surface; `typewriter` swaps in warm
   * stock, a narrower measure, looser leading and a block cursor. */
  appearance: 'app' | 'typewriter';
  /** Dim every block but the one holding the cursor. */
  lineFocus: 'off' | 'paragraph';
  /** Pin the caret's line at a fixed height instead of letting it walk down
   * the window. */
  typewriterScrolling: boolean;
  /** Let the title bar and status bar leave until the pointer reaches for
   * them. */
  hideChrome: boolean;
  /** Take the whole screen. The only way macOS will hide the traffic lights
   * it draws over our overlay title bar. */
  fullscreen: boolean;
}

export interface PodcastSettings {
  mode: 'narrator' | 'dialogue';
  /** Target episode length, in minutes. */
  minutes: number;
}

export interface AppSettings {
  /** Set only after the starter course has been written successfully. Keeping
   * this in settings means deleting that course later does not resurrect it. */
  onboardingCompleted: boolean;
  locale: 'en' | 'fr';
  theme: 'light' | 'dark' | 'system';
  accentColor: AccentColor;
  editorFont: 'sans' | 'avenir' | 'serif' | 'claude' | 'iowan' | 'mono';
  editorFontSize: number;
  editorTitleSize: number;
  /** Line length, in rem — the reading measure. Kept in rem rather than
   * characters so it stays honest across the six editor fonts, and adjustable
   * because 65–75 characters is a good default, not a law. */
  editorMeasure: number;
  /** Typing shortcuts expanded as the note is written, in match order. */
  abbreviations: Abbreviation[];
  /** How concentration mode behaves and reads. */
  focus: FocusSettings;
  /** Trash retention, in days. */
  trashRetentionDays: number;
  /** How aggressively old per-note versions are thinned. */
  snapshotRetention: 'standard' | 'extended' | 'forever';
  backupSchedule: 'off' | 'daily' | 'weekly';
  /** Where scheduled backups land. `null` means the folder NotaBene manages
   * inside its own app data directory — which is what makes backups work on a
   * fresh install with nothing configured. */
  backupFolder: string | null;
  /** How many archives to keep. Applies **only** to the managed folder: files
   * in a folder the user chose are theirs, and NotaBene never deletes them. */
  backupsToKeep: number;
  lastBackupAt: string | null;
  /** Where the last successful backup landed, so Settings can name it. */
  lastBackupPath: string | null;
  /** Why the last attempt failed, and when. Cleared by the next success —
   * without these, "backups are on" and "backups are working" look identical. */
  lastBackupError: string | null;
  lastBackupErrorAt: string | null;
  /** Set once, when the daily-by-default schedule is applied to a profile that
   * predates it. Distinguishes "never chose" from "chose off". */
  backupDefaultsApplied: boolean;
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
  /** Speech configuration is shared by read-aloud and podcast playback. */
  speech: SpeechSettings;
  /** Script-specific podcast preferences. */
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
  onboardingCompleted: false,
  locale: 'en',
  theme: 'system',
  accentColor: 'orange',
  editorFont: 'sans',
  editorFontSize: 16,
  editorTitleSize: 40,
  editorMeasure: 42,
  abbreviations: [],
  focus: {
    appearance: 'typewriter',
    lineFocus: 'paragraph',
    typewriterScrolling: true,
    hideChrome: true,
    fullscreen: false,
  },
  trashRetentionDays: 30,
  snapshotRetention: 'standard',
  // On by default, into NotaBene's own folder. An unprotected library is the
  // default state that costs the most and is hardest to notice.
  backupSchedule: 'daily',
  backupFolder: null,
  backupsToKeep: 10,
  lastBackupAt: null,
  lastBackupPath: null,
  lastBackupError: null,
  lastBackupErrorAt: null,
  backupDefaultsApplied: true,
  exportPreset: {
    format: 'pdf',
    layout: 'combined',
    includeToc: true,
  },
  aiFeatureModels: {},
  aiProviders: {},
  speech: {
    engineId: 'system',
    voicesByEngine: {},
    localModelRevisions: {},
    playbackRate: 1,
    fallbackToSystem: false,
  },
  podcast: { mode: 'narrator', minutes: 6 },
  mcpEnabled: false,
  mcpPort: 22600,
  checkForUpdates: true,
  viewSorts: {},
  recentSearches: [],
};
