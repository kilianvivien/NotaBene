/**
 * Self-update state (desktop only).
 *
 * The resolved release, download progress and errors are session state — a
 * relaunch checks again from scratch. The two preferences, whether to check in
 * the background and which version was skipped, live in `settingsStore`.
 *
 * A background check never interrupts. It fills in this store, and the status
 * bar shows a small "update" item only when there is something to install that
 * the student has not skipped; a failed background check says nothing. A
 * manual check (the menu command) always answers, including "up to date".
 */
import { create } from 'zustand';
import {
  appLifecycle,
  appUpdater,
  UpdaterUnavailableError,
  type AvailableUpdate,
  type UpdaterUnavailableReason,
} from '@/lib/adapters';
import { useDictationStore } from './dictationStore';
import { useEditorStore } from './editorStore';
import { useRecordingStore } from './recordingStore';
import { useSettingsStore } from './settingsStore';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  /** A newer release was found and has not been downloaded. */
  | 'available'
  | 'downloading'
  /** The new bundle is on disk; a restart switches to it. */
  | 'ready'
  /** The last install failed. A failed *check* returns to `idle`. */
  | 'error'
  | 'unsupported';

export type UpdateErrorReason = UpdaterUnavailableReason | 'install' | 'signature';

/** What a check found, so the caller that asked can say it. */
export type UpdateCheckOutcome =
  | { kind: 'available'; version: string }
  | { kind: 'current' }
  | { kind: 'busy' }
  | { kind: 'failed'; reason: UpdateErrorReason };

/** Why a restart was refused: relaunching mid-recording would end the capture. */
export type RestartRefusal = 'recording' | 'dictation';

/** The signature is checked only after the download, so a tampered or unsigned
 * bundle surfaces at install time, never at check time. */
const SIGNATURE_FAILURE = /signature|minisign/i;

function reasonOf(error: unknown): UpdateErrorReason {
  if (error instanceof UpdaterUnavailableError) return error.reason;
  const message = (error as { message?: string } | undefined)?.message ?? String(error);
  return SIGNATURE_FAILURE.test(message) ? 'signature' : 'install';
}

export interface UpdaterState {
  phase: UpdatePhase;
  update: AvailableUpdate | null;
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number;
  error: UpdateErrorReason | null;
  /** Whether the status bar offers the release. False for a skipped version
   * found in the background, or after "Later". */
  offered: boolean;
  popoverOpen: boolean;

  check(options?: { manual?: boolean }): Promise<UpdateCheckOutcome>;
  install(): Promise<void>;
  /** Save the open note and relaunch into the installed version. */
  restart(): Promise<RestartRefusal | null>;
  /** Stay quiet about this version in background checks. */
  skip(): Promise<void>;
  /** Hide the offer until the next check. */
  later(): void;
  setPopoverOpen(open: boolean): void;
}

const CLEARED = {
  update: null,
  version: null,
  notes: null,
  downloaded: 0,
  total: 0,
  error: null,
  offered: false,
  popoverOpen: false,
} as const;

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  phase: 'idle',
  ...CLEARED,

  async check({ manual = false } = {}) {
    if (!appUpdater.supported) {
      set({ phase: 'unsupported' });
      return { kind: 'failed', reason: 'platform' };
    }
    const { phase } = get();
    // Never re-check out from under a download, or away from an update that is
    // already installed and waiting for a restart.
    if (phase === 'checking' || phase === 'downloading') return { kind: 'busy' };
    if (phase === 'ready') {
      if (manual) set({ offered: true, popoverOpen: true });
      return { kind: 'available', version: get().version ?? '' };
    }

    set({ phase: 'checking' });
    let update: AvailableUpdate | null;
    try {
      update = await appUpdater.check();
    } catch (error) {
      set({ phase: get().update ? 'available' : 'idle' });
      return { kind: 'failed', reason: reasonOf(error) };
    }

    void get().update?.dispose();
    if (!update) {
      set({ phase: 'idle', ...CLEARED });
      return { kind: 'current' };
    }
    const skipped =
      useSettingsStore.getState().settings.skippedUpdateVersion === update.version;
    set({
      phase: 'available',
      ...CLEARED,
      update,
      version: update.version,
      notes: update.notes ?? null,
      offered: manual || !skipped,
      popoverOpen: manual,
    });
    return { kind: 'available', version: update.version };
  },

  async install() {
    const { update, phase } = get();
    if (!update || phase === 'downloading' || phase === 'ready') return;
    set({ phase: 'downloading', downloaded: 0, total: 0, error: null });
    try {
      await update.install((progress) =>
        set({ downloaded: progress.downloaded, total: progress.total }),
      );
      set({ phase: 'ready' });
    } catch (error) {
      set({ phase: 'error', error: reasonOf(error) });
    }
  },

  async restart() {
    if (useRecordingStore.getState().status !== 'idle') return 'recording';
    if (useDictationStore.getState().status !== 'idle') return 'dictation';
    // The same order as moving the library: nothing typed is left in memory.
    await useEditorStore.getState().flush();
    await appLifecycle.relaunch();
    return null;
  },

  async skip() {
    const { version } = get();
    void get().update?.dispose();
    set({ phase: 'idle', ...CLEARED });
    if (version) await useSettingsStore.getState().update({ skippedUpdateVersion: version });
  },

  later() {
    // An installed update stays installed; only the offer is hidden.
    set({ offered: false, popoverOpen: false });
  },

  setPopoverOpen(open) {
    set({ popoverOpen: open });
  },
}));

/** Whether the status bar shows the update item at all. */
export function updateOffered(state: UpdaterState): boolean {
  if (!state.offered) return false;
  return (
    state.phase === 'available' ||
    state.phase === 'downloading' ||
    state.phase === 'ready' ||
    state.phase === 'error'
  );
}
