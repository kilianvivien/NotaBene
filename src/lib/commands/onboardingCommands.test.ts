import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { resetMemorySettings } from '@/lib/adapters/settings/memorySettingsAdapter';
import { DEFAULT_SETTINGS } from '@/lib/adapters';
import {
  createNoteCommand,
  firstRunPendingCommand,
  runOnboardingCommand,
  skipOnboardingCommand,
} from '@/lib/commands';
import { useSettingsStore } from '@/lib/state/settingsStore';

beforeEach(() => {
  memoryLibraryAdapter.reset();
  resetMemorySettings();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});

describe('first run', () => {
  it('asks how to begin on an empty library', async () => {
    const pending = await firstRunPendingCommand();
    expect(pending.ok && pending.value).toBe(true);
    // Asking writes nothing: dismissing the question must leave it open.
    expect(useSettingsStore.getState().settings.onboardingCompleted).toBe(false);
    expect(await memoryLibraryAdapter.listCourses()).toHaveLength(0);
  });

  it('closes quietly over a library that already holds notes', async () => {
    await createNoteCommand({ title: 'Brought along' });
    const pending = await firstRunPendingCommand();
    expect(pending.ok && pending.value).toBe(false);
    expect(useSettingsStore.getState().settings.onboardingCompleted).toBe(true);
  });

  it('starting empty or importing adds no starter material', async () => {
    expect((await skipOnboardingCommand()).ok).toBe(true);
    expect(useSettingsStore.getState().settings.onboardingCompleted).toBe(true);
    const pending = await firstRunPendingCommand();
    expect(pending.ok && pending.value).toBe(false);
    // The sample course is not created behind the student's back afterwards.
    await runOnboardingCommand();
    expect(await memoryLibraryAdapter.listCourses()).toHaveLength(0);
  });

  it('choosing the sample course closes the first run', async () => {
    await runOnboardingCommand();
    const pending = await firstRunPendingCommand();
    expect(pending.ok && pending.value).toBe(false);
    expect(await memoryLibraryAdapter.queryNotes({ scope: 'live' })).toHaveLength(2);
  });
});
