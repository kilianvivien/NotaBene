/**
 * Whether the window has the whole screen, as an attribute the stylesheet can
 * read.
 *
 * Concentration mode hides the title bar but keeps its band, because the bar is
 * the drag region and — windowed — the traffic lights are drawn over it by
 * macOS. Fullscreen there are no traffic lights and nothing to drag, so the
 * band is 44px of nothing at the top of the page, and that is the one case
 * where the editor can have it back (`globals.css`).
 *
 * Only watched while concentration mode is on: outside it nothing reads the
 * attribute, and `onResized` fires for every pixel of a window drag.
 */
import { useEffect } from 'react';
import { appWindow } from '@/lib/adapters';
import { useUiStore } from '@/lib/state/uiStore';

export function useFullscreenAttribute(): void {
  const focusMode = useUiStore((state) => state.focusMode);

  useEffect(() => {
    if (!focusMode) {
      delete document.documentElement.dataset.fullscreen;
      return;
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    const apply = (fullscreen: boolean) => {
      if (!active) return;
      document.documentElement.dataset.fullscreen = String(fullscreen);
    };

    void appWindow.isFullscreen().then(apply);
    void appWindow.onFullscreenChange(apply).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
      delete document.documentElement.dataset.fullscreen;
    };
  }, [focusMode]);
}
