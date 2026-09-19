import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  appleFm,
  type AppleFmPreflight,
  type AppleFmStatus,
  type AppSettings,
} from '@/lib/adapters';
import { useSettingsStore } from './settingsStore';

const STOPPED: AppleFmStatus = {
  running: false,
  port: null,
  managed: false,
  error: null,
};

interface AppleFmState {
  preflight: AppleFmPreflight | null;
  status: AppleFmStatus;
  pending: boolean;
  error: string | null;

  initialize(): Promise<void>;
  refresh(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  ensureRunning(): Promise<void>;
}

function configuredPort(settings: AppSettings): number | undefined {
  const configured = settings.aiProviders.apple?.baseUrl?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function appleConfig(settings: AppSettings, enabled: boolean, port?: number) {
  const current = settings.aiProviders.apple;
  return {
    ...settings.aiProviders,
    apple: {
      enabled,
      baseUrl: port ? `http://127.0.0.1:${port}/v1` : (current?.baseUrl ?? null),
      extraModels: current?.extraModels ?? [],
    },
  };
}

export const useAppleFmStore = create<AppleFmState>()(
  immer((set, get) => ({
    preflight: null,
    status: STOPPED,
    pending: false,
    error: null,

    async initialize() {
      if (useSettingsStore.getState().settings.aiProviders.apple?.enabled === true) {
        await get().ensureRunning();
      }
    },

    async refresh() {
      try {
        const [preflight, status] = await Promise.all([
          appleFm.preflight(),
          appleFm.status(),
        ]);
        set((state) => {
          state.preflight = preflight;
          state.status = status;
          state.error = status.error;
        });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
      }
    },

    async setEnabled(enabled) {
      const settings = useSettingsStore.getState().settings;
      await useSettingsStore.getState().update({
        aiProviders: appleConfig(settings, enabled),
      });
      if (!enabled) {
        try {
          await appleFm.stop();
          set((state) => {
            state.status = STOPPED;
            state.error = null;
          });
        } catch (error) {
          set((state) => {
            state.error = error instanceof Error ? error.message : String(error);
          });
        }
        return;
      }
      await get().ensureRunning();
    },

    async ensureRunning() {
      if (get().pending) return;
      set((state) => {
        state.pending = true;
        state.error = null;
      });
      try {
        const currentStatus = await appleFm.status();
        if (currentStatus.running && currentStatus.port !== null) {
          set((state) => {
            state.status = currentStatus;
            state.error = null;
          });
          return;
        }
        const preflight = await appleFm.preflight();
        set((state) => {
          state.preflight = preflight;
        });
        if (!preflight.installed || !preflight.osOk) throw new Error('apple_fm_not_installed');
        if (!preflight.licensed) throw new Error('apple_fm_not_licensed');
        if (preflight.model !== 'available') {
          throw new Error(`apple_fm_${preflight.model}`);
        }

        const settings = useSettingsStore.getState().settings;
        const port = await appleFm.start(configuredPort(settings));
        await useSettingsStore.getState().update({
          aiProviders: appleConfig(settings, true, port),
        });
        const status = await appleFm.status();
        set((state) => {
          state.status = status;
          state.error = status.error;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          state.status = { ...STOPPED, error: message };
          state.error = message;
        });
      } finally {
        set((state) => {
          state.pending = false;
        });
      }
    },
  })),
);

export { configuredPort };
