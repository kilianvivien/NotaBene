import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WindowAdapter } from './WindowAdapter';

export const tauriWindowAdapter: WindowAdapter = {
  setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
  isFullscreen: () => getCurrentWindow().isFullscreen(),

  // Tauri has no fullscreen event, but a fullscreen transition is a resize, and
  // the window is the one that knows the answer afterwards.
  async onFullscreenChange(listener) {
    const window = getCurrentWindow();
    return window.onResized(() => {
      void window.isFullscreen().then(listener);
    });
  },
};
