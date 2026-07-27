/** App settings, and the DOM side effects that make them visible. Theme and
 * transparency are applied to `<html>` as data attributes so the token sheets
 * swap without a re-render. */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { appSettings, DEFAULT_SETTINGS, type AppSettings } from '@/lib/adapters';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;

  load(): Promise<void>;
  update(patch: Partial<AppSettings>): Promise<void>;
}

function resolveTheme(theme: AppSettings['theme']): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applySettingsToDom(settings: AppSettings): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings.theme);
  root.dataset.transparency = settings.transparency;
  root.dataset.accent = settings.accentColor;
  root.lang = settings.locale;
  root.style.setProperty('--nb-editor-size', `${settings.editorFontSize}px`);
  root.style.setProperty(
    '--nb-editor-font',
    settings.editorFont === 'serif' ? 'var(--nb-font-serif)' : 'var(--nb-font-sans)',
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
      const merged = { ...DEFAULT_SETTINGS, ...stored };
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
