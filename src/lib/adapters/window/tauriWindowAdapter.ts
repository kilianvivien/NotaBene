import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WindowAdapter } from './WindowAdapter';

export const tauriWindowAdapter: WindowAdapter = {
  setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
  isFullscreen: () => getCurrentWindow().isFullscreen(),
};
