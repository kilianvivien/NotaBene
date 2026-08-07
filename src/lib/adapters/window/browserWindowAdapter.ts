import type { WindowAdapter } from './WindowAdapter';

/**
 * The Fullscreen API needs a user gesture, and concentration mode is always
 * entered by one — a shortcut, a menu item or a button. A rejected request is
 * therefore a browser policy decision rather than a bug, and is swallowed: the
 * mode itself still works, it just does not take the screen.
 */
export const browserWindowAdapter: WindowAdapter = {
  async setFullscreen(on) {
    try {
      if (on) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen?.();
    } catch {
      // Denied by the browser; nothing to recover.
    }
  },

  async isFullscreen() {
    return document.fullscreenElement !== null;
  },

  async onFullscreenChange(listener) {
    const onChange = () => listener(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  },
};
