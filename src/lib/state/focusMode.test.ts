import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/adapters';
import { migrateSettings } from './settingsStore';
import { isOverlayOpen, useUiStore } from './uiStore';

describe('concentration mode layout', () => {
  beforeEach(() => {
    useUiStore.setState({
      focusMode: false,
      focusRestore: null,
      focusSession: null,
      chromeRevealed: false,
      sidebarVisible: true,
      noteListVisible: true,
      inspectorVisible: false,
    });
  });

  it('puts the panes back exactly as they were', () => {
    // A layout nobody would arrive at by accident, so a restore that merely
    // resets to defaults cannot pass this.
    useUiStore.setState({
      sidebarVisible: false,
      noteListVisible: true,
      inspectorVisible: true,
    });

    useUiStore.getState().setFocusMode(true);
    expect(useUiStore.getState()).toMatchObject({
      focusMode: true,
      sidebarVisible: false,
      noteListVisible: false,
      inspectorVisible: false,
    });

    useUiStore.getState().setFocusMode(false);
    expect(useUiStore.getState()).toMatchObject({
      focusMode: false,
      focusRestore: null,
      sidebarVisible: false,
      noteListVisible: true,
      inspectorVisible: true,
    });
  });

  it('keeps the recorded layout when a pane is peeked mid-session', () => {
    useUiStore.getState().setFocusMode(true);
    // Glancing at the inspector without leaving the mode.
    useUiStore.getState().toggleInspector();
    expect(useUiStore.getState().inspectorVisible).toBe(true);

    useUiStore.getState().setFocusMode(false);
    expect(useUiStore.getState().inspectorVisible).toBe(false);
  });

  it('does not re-record the layout when already in the mode', () => {
    useUiStore.getState().setFocusMode(true);
    // A second entry must not overwrite the restore point with the collapsed
    // layout the mode itself created.
    useUiStore.getState().setFocusMode(true);

    useUiStore.getState().setFocusMode(false);
    expect(useUiStore.getState()).toMatchObject({
      sidebarVisible: true,
      noteListVisible: true,
    });
  });

  it('stamps and clears the sitting', () => {
    useUiStore.getState().setFocusMode(true, 120);
    expect(useUiStore.getState().focusSession?.startWords).toBe(120);

    useUiStore.getState().setFocusMode(false);
    expect(useUiStore.getState().focusSession).toBeNull();
  });

  it('reports an overlay whichever one is open', () => {
    expect(isOverlayOpen(useUiStore.getState())).toBe(false);
    useUiStore.getState().setAiPodcastOpen(true);
    expect(isOverlayOpen(useUiStore.getState())).toBe(true);
    useUiStore.getState().setAiPodcastOpen(false);
  });
});

describe('focus settings migration', () => {
  it('replaces the dead focusMode boolean with the focus group', () => {
    const stored = { focusMode: true } as unknown as Parameters<
      typeof migrateSettings
    >[0];
    const migrated = migrateSettings(stored);

    expect(migrated.focus).toEqual(DEFAULT_SETTINGS.focus);
    expect(migrated).not.toHaveProperty('focusMode');
  });

  it('fills a partial focus group from the defaults', () => {
    const migrated = migrateSettings({
      focus: { lineFocus: 'off' },
    } as unknown as Parameters<typeof migrateSettings>[0]);

    expect(migrated.focus).toEqual({ ...DEFAULT_SETTINGS.focus, lineFocus: 'off' });
  });

  it('leaves a fully stored focus group alone', () => {
    const focus = {
      appearance: 'app',
      lineFocus: 'off',
      typewriterScrolling: false,
      hideChrome: false,
      fullscreen: true,
    } as const;

    expect(migrateSettings({ focus }).focus).toEqual(focus);
  });
});
