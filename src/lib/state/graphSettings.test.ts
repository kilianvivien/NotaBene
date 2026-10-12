import { beforeEach, describe, expect, it } from 'vitest';
import { appSettings, DEFAULT_SETTINGS } from '@/lib/adapters';
import { migrateSettings, useSettingsStore } from './settingsStore';

beforeEach(() =>
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) }),
);

describe('graph preferences', () => {
  it('migrates an older profile to the larger cross-provider output allowance', () => {
    expect(migrateSettings({}).graph).toEqual(DEFAULT_SETTINGS.graph);
    expect(migrateSettings({}).graph.maxOutputTokens).toBe(16_384);
  });

  it('fills missing fields and bounds hand-edited request sizes', () => {
    expect(
      migrateSettings({
        graph: {
          maxOutputTokens: Infinity,
          maxNotes: 0,
          excerptChars: 9_000,
          maxSuggestions: 4.4,
          showMentions: 'yes',
          linkedOnly: true,
        },
      } as never).graph,
    ).toEqual({
      ...DEFAULT_SETTINGS.graph,
      maxNotes: 2,
      excerptChars: 2_000,
      maxSuggestions: 4,
      linkedOnly: true,
    });
    expect(
      migrateSettings({ graph: { maxOutputTokens: 1_000_000 } } as never).graph
        .maxOutputTokens,
    ).toBe(65_536);
  });

  it('persists the chosen preferences and restores them on load', async () => {
    const graph = {
      ...DEFAULT_SETTINGS.graph,
      showMentions: true,
      maxOutputTokens: 32_768,
    };
    await useSettingsStore.getState().update({ graph });
    expect((await appSettings.load()).graph).toEqual(graph);
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings.graph).toEqual(graph);
  });
});
