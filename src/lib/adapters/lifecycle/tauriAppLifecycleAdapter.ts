import { relaunch } from '@tauri-apps/plugin-process';
import type { AppLifecycleAdapter } from './AppLifecycleAdapter';

export const tauriAppLifecycleAdapter: AppLifecycleAdapter = { relaunch };

export const browserAppLifecycleAdapter: AppLifecycleAdapter = {
  async relaunch() {
    window.location.reload();
  },
};
