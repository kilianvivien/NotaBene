import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailableUpdate } from '@/lib/adapters';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock('@/lib/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters')>();
  return {
    ...actual,
    appUpdater: { supported: true, check: mocks.check },
    appLifecycle: { relaunch: mocks.relaunch },
  };
});

const { UpdaterUnavailableError } = await import('@/lib/adapters');
const { updateOffered, useUpdaterStore } = await import('./updaterStore');
const { useSettingsStore } = await import('./settingsStore');
const { useRecordingStore } = await import('./recordingStore');
const { useEditorStore } = await import('./editorStore');

const INITIAL = useUpdaterStore.getState();

function fakeUpdate(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    version: '1.5.0',
    notes: 'Faster search.',
    install: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdaterStore.setState(INITIAL, true);
  useSettingsStore.setState((state) => {
    state.settings.skippedUpdateVersion = null;
  });
  useRecordingStore.setState({ status: 'idle' });
});

describe('updater store', () => {
  it('offers a release found in the background without opening the popover', async () => {
    mocks.check.mockResolvedValue(fakeUpdate());
    await expect(useUpdaterStore.getState().check()).resolves.toEqual({
      kind: 'available',
      version: '1.5.0',
    });
    const state = useUpdaterStore.getState();
    expect(state.phase).toBe('available');
    expect(state.popoverOpen).toBe(false);
    expect(updateOffered(state)).toBe(true);
  });

  it('stays quiet about a skipped version until the student asks', async () => {
    useSettingsStore.setState((state) => {
      state.settings.skippedUpdateVersion = '1.5.0';
    });
    mocks.check.mockResolvedValue(fakeUpdate());
    await useUpdaterStore.getState().check();
    expect(updateOffered(useUpdaterStore.getState())).toBe(false);

    mocks.check.mockResolvedValue(fakeUpdate());
    await useUpdaterStore.getState().check({ manual: true });
    expect(updateOffered(useUpdaterStore.getState())).toBe(true);
    expect(useUpdaterStore.getState().popoverOpen).toBe(true);
  });

  it('reports up to date and a failed check without leaving an offer', async () => {
    mocks.check.mockResolvedValue(null);
    await expect(useUpdaterStore.getState().check()).resolves.toEqual({ kind: 'current' });

    mocks.check.mockRejectedValue(new UpdaterUnavailableError('network', 'offline'));
    await expect(useUpdaterStore.getState().check()).resolves.toEqual({
      kind: 'failed',
      reason: 'network',
    });
    expect(useUpdaterStore.getState().phase).toBe('idle');
    expect(updateOffered(useUpdaterStore.getState())).toBe(false);
  });

  it('installs with progress, then waits for a restart', async () => {
    const update = fakeUpdate({
      install: vi.fn(async (onProgress) => {
        onProgress?.({ downloaded: 50, total: 100 });
      }),
    });
    mocks.check.mockResolvedValue(update);
    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().install();
    const state = useUpdaterStore.getState();
    expect(state.phase).toBe('ready');
    expect(state.downloaded).toBe(50);
    expect(mocks.relaunch).not.toHaveBeenCalled();

    // A later background check must not replace an installed update.
    await useUpdaterStore.getState().check();
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it('names a signature failure apart from other install failures', async () => {
    mocks.check.mockResolvedValue(
      fakeUpdate({ install: vi.fn().mockRejectedValue(new Error('invalid signature')) }),
    );
    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().install();
    expect(useUpdaterStore.getState()).toMatchObject({ phase: 'error', error: 'signature' });
  });

  it('remembers a skipped version in settings', async () => {
    mocks.check.mockResolvedValue(fakeUpdate());
    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().skip();
    expect(useSettingsStore.getState().settings.skippedUpdateVersion).toBe('1.5.0');
    expect(updateOffered(useUpdaterStore.getState())).toBe(false);
  });

  it('refuses to restart over a recording, and saves the note first otherwise', async () => {
    useRecordingStore.setState({ status: 'recording' });
    await expect(useUpdaterStore.getState().restart()).resolves.toBe('recording');
    expect(mocks.relaunch).not.toHaveBeenCalled();

    useRecordingStore.setState({ status: 'idle' });
    const flush = vi.spyOn(useEditorStore.getState(), 'flush').mockResolvedValue();
    await expect(useUpdaterStore.getState().restart()).resolves.toBeNull();
    expect(flush).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
