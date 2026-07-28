/** App settings, and the DOM side effects that make them visible. Theme and
 * accent are applied to `<html>` as data attributes so the token sheets swap
 * without a re-render. */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { appSettings, DEFAULT_SETTINGS, type AppSettings } from '@/lib/adapters';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;

  load(): Promise<void>;
  update(patch: Partial<AppSettings>): Promise<void>;
}

interface LegacyPodcastSettings {
  voiceId?: string | null;
  rate?: number;
  mode?: AppSettings['podcast']['mode'];
  minutes?: number;
}

/**
 * Migrate the Phase G global voice/rate fields into an engine-scoped speech
 * configuration. Kept pure so migration can be exercised without storage.
 */
export function migrateSettings(stored: Partial<AppSettings>): AppSettings {
  const legacyPodcast = stored.podcast as
    (Partial<AppSettings['podcast']> & LegacyPodcastSettings) | undefined;
  const storedSpeech = stored.speech;
  const legacyVoice = legacyPodcast?.voiceId;

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    speech: {
      ...DEFAULT_SETTINGS.speech,
      ...storedSpeech,
      voicesByEngine: {
        ...DEFAULT_SETTINGS.speech.voicesByEngine,
        ...(legacyVoice ? { system: legacyVoice } : {}),
        ...storedSpeech?.voicesByEngine,
      },
      playbackRate:
        storedSpeech?.playbackRate ??
        (typeof legacyPodcast?.rate === 'number'
          ? legacyPodcast.rate
          : DEFAULT_SETTINGS.speech.playbackRate),
    },
    podcast: {
      mode: legacyPodcast?.mode ?? DEFAULT_SETTINGS.podcast.mode,
      minutes: legacyPodcast?.minutes ?? DEFAULT_SETTINGS.podcast.minutes,
    },
  };
}

function resolveTheme(theme: AppSettings['theme']): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applySettingsToDom(settings: AppSettings): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings.theme);
  root.dataset.accent = settings.accentColor;
  root.lang = settings.locale;
  root.style.setProperty('--nb-editor-size', `${settings.editorFontSize}px`);
  root.style.setProperty('--nb-editor-title-size', `${settings.editorTitleSize}px`);
  const editorFonts: Record<AppSettings['editorFont'], string> = {
    sans: 'var(--nb-font-sans)',
    avenir: 'var(--nb-font-avenir)',
    serif: 'var(--nb-font-serif)',
    claude: 'var(--nb-font-claude)',
    iowan: 'var(--nb-font-iowan)',
    mono: 'var(--nb-font-mono)',
  };
  root.style.setProperty(
    '--nb-editor-font',
    editorFonts[settings.editorFont] ?? editorFonts.sans,
  );
}

/**
 * Keep `theme: 'system'` honest: macOS switches appearance at sunset, and an
 * app that only read the preference at launch would sit there glowing white
 * all evening. Returns an unsubscribe function.
 */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!media) return () => {};

  const onChange = () => {
    const { settings } = useSettingsStore.getState();
    if (settings.theme === 'system') applySettingsToDom(settings);
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export const useSettingsStore = create<SettingsState>()(
  immer((set, get) => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,

    async load() {
      const stored = await appSettings.load();
      const merged = migrateSettings(stored);
      applySettingsToDom(merged);
      set((state) => {
        state.settings = merged;
        state.loaded = true;
      });
    },

    async update(patch) {
      const merged = { ...get().settings, ...patch };
      applySettingsToDom(merged);
      set((state) => {
        state.settings = merged;
      });
      await appSettings.save(merged);
    },
  })),
);
