/**
 * When the title bar and status bar are allowed on screen in concentration
 * mode.
 *
 * This is a single `pointermove` listener rather than hover zones pinned to the
 * edges, because a hot zone thin enough not to be in the way is also thinner
 * than the bar it reveals: the pointer moves off the zone and onto the bar, the
 * zone's `pointerleave` fires, and the bar retreats out from under the cursor.
 * Comparing `clientY` against the bars' own heights has no such seam.
 *
 * Chrome is also forced back whenever something modal is open — the command
 * palette puts focus in the title bar's field, and a field inside a bar that is
 * sliding away is not a search box.
 */
import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { isOverlayOpen, useUiStore } from '@/lib/state/uiStore';

/** How close to an edge the pointer must be. The top figure is the title bar's
 * own height (`--nb-titlebar-height`) plus a little slack, so the bar stays out
 * while the pointer rests on it; the bottom matches the 24px status bar. */
const TOP_REACH = 52;
const BOTTOM_REACH = 32;

export function useChromeRevealed(): boolean {
  const focusMode = useUiStore((state) => state.focusMode);
  const chromeRevealed = useUiStore((state) => state.chromeRevealed);
  const hideChrome = useSettingsStore((state) => state.settings.focus.hideChrome);
  const overlayOpen = useUiStore(isOverlayOpen);

  const hiding = focusMode && hideChrome;

  useEffect(() => {
    const { setChromeRevealed } = useUiStore.getState();
    if (!hiding) {
      setChromeRevealed(false);
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const nearEdge =
        event.clientY <= TOP_REACH || event.clientY >= window.innerHeight - BOTTOM_REACH;
      const next = nearEdge || isOverlayOpen(useUiStore.getState());
      if (next !== useUiStore.getState().chromeRevealed) setChromeRevealed(next);
    };

    window.addEventListener('pointermove', onPointerMove);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      setChromeRevealed(false);
    };
  }, [hiding]);

  return !hiding || chromeRevealed || overlayOpen;
}
