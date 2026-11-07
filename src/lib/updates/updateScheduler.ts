/**
 * Background update checks.
 *
 * The first waits until launch has settled — hydrating the library, the
 * first-run screen and the reminder catch-up all come first, and an update is
 * never urgent. After that, a check every few hours, so a laptop that stays
 * open for a week still hears about a release. Each tick reads the setting
 * afresh, so turning it off takes effect without a relaunch.
 */
import { appUpdater } from '@/lib/adapters';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUpdaterStore } from '@/lib/state/updaterStore';

const FIRST_CHECK_DELAY_MS = 10_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startUpdateChecks(): () => void {
  if (!appUpdater.supported) return () => {};

  const tick = () => {
    if (!useSettingsStore.getState().settings.checkForUpdates) return;
    void useUpdaterStore.getState().check();
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, RECHECK_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);

  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
