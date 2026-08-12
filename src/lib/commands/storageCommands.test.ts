import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appLifecycle, dialog, storage } from '@/lib/adapters';
import { DEFAULT_SETTINGS } from '@/lib/adapters/settings/SettingsAdapter';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { relocateLibraryCommand } from './storageCommands';

describe('library relocation command', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
    useLibraryAccessStore.setState({
      loaded: true,
      status: {
        libraryDir: '/current',
        readOnly: false,
        lockOwner: null,
      },
    });
    useEditorStore.setState({ note: null, saveState: 'idle', error: null });
  });

  it('does nothing when the folder picker is cancelled', async () => {
    vi.spyOn(dialog, 'openFolder').mockResolvedValue(null);
    const relocate = vi.spyOn(storage, 'relocateLibrary');

    expect(await relocateLibraryCommand()).toEqual({ ok: true, value: false });
    expect(relocate).not.toHaveBeenCalled();
  });

  it('refuses to copy a library that is already read-only', async () => {
    useLibraryAccessStore.setState({
      status: {
        libraryDir: '/current',
        readOnly: true,
        lockOwner: { host: 'Lecture Mac', processId: 42, updatedAt: 'now' },
      },
    });
    const picker = vi.spyOn(dialog, 'openFolder');

    const result = await relocateLibraryCommand();

    expect(result.ok).toBe(false);
    expect(picker).not.toHaveBeenCalled();
  });

  it('switches settings only after the verified copy and then relaunches', async () => {
    vi.spyOn(dialog, 'openFolder').mockResolvedValue('/picked');
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    vi.spyOn(storage, 'relocateLibrary').mockResolvedValue('/picked/canonical');
    const relaunch = vi.spyOn(appLifecycle, 'relaunch').mockResolvedValue();

    expect(await relocateLibraryCommand()).toEqual({ ok: true, value: true });
    expect(useSettingsStore.getState().settings.libraryLocation).toBe(
      '/picked/canonical',
    );
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('keeps the current setting when native verification fails', async () => {
    vi.spyOn(dialog, 'openFolder').mockResolvedValue('/picked');
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true);
    vi.spyOn(storage, 'relocateLibrary').mockRejectedValue(
      new Error('LIBRARY_COPY_INVALID: damaged copy'),
    );
    const relaunch = vi.spyOn(appLifecycle, 'relaunch');

    const result = await relocateLibraryCommand();

    expect(result.ok).toBe(false);
    expect(useSettingsStore.getState().settings.libraryLocation).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
