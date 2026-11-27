import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/common.json';
import fr from '@/locales/fr/common.json';
import type { SettingsTab } from '@/lib/state/uiStore';
import {
  SETTINGS_PANES,
  paneKeywordsKey,
  paneLabelKey,
  searchSettings,
  sectionKeywordsKey,
} from './settingsIndex';

function lookup(bundle: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      bundle,
    );
  return typeof value === 'string' ? value : undefined;
}

const translator = (bundle: unknown) => (key: string) => lookup(bundle, key) ?? key;

/** Every tab the `SettingsTab` union names, read from the source so a new tab
 * cannot be added to the union and forgotten here. */
function settingsTabs(): SettingsTab[] {
  const source = readFileSync('src/lib/state/uiStore.ts', 'utf8');
  const union = /export type SettingsTab =([^;]+);/.exec(source)?.[1] ?? '';
  return [...union.matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1] as SettingsTab);
}

describe('the Settings index', () => {
  it('lists every settings tab exactly once', () => {
    const listed = SETTINGS_PANES.map((pane) => pane.id);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(settingsTabs().sort());
  });

  it('gives every section a unique anchor', () => {
    const anchors = SETTINGS_PANES.flatMap((pane) => pane.sections.map((s) => s.id));
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it.each([
    ['en', en],
    ['fr', fr],
  ])('resolves every label and keyword in %s', (_locale, bundle) => {
    for (const pane of SETTINGS_PANES) {
      expect(lookup(bundle, paneLabelKey(pane.id)), pane.id).toBeTruthy();
      expect(lookup(bundle, paneKeywordsKey(pane.id)), pane.id).toBeTruthy();
      for (const section of pane.sections) {
        expect(lookup(bundle, section.titleKey), section.titleKey).toBeTruthy();
        expect(lookup(bundle, sectionKeywordsKey(section.id)), section.id).toBeTruthy();
      }
    }
  });

  it('carries every anchor into a pane', () => {
    const sources = [
      'SettingsWindow',
      'GraphSettings',
      'SpeechSettings',
      'RecordingSettings',
      'TranscriptionSettings',
      'DictationSettings',
      'BackupSettings',
      'DataStorageSettings',
      'AiProviderSettings',
      'AgentSettings',
      'AgentInstructionsSettings',
      'AgentReviewSettings',
      'AgentReasoningSettings',
      'AboutSettings',
    ]
      .map((name) => readFileSync(`src/app/settings/${name}.tsx`, 'utf8'))
      .join('\n');
    for (const pane of SETTINGS_PANES) {
      for (const section of pane.sections) {
        expect(sources, section.id).toMatch(
          new RegExp(`(anchor|data-field-anchor)="${section.id}"`),
        );
      }
    }
  });
});

describe('searchSettings', () => {
  const t = translator(en);
  const tFr = translator(fr);
  const shape = (query: string, translate = t) =>
    searchSettings(query, translate).map((hit) => [
      hit.pane.id,
      hit.sections.map((s) => s.id),
    ]);

  it('returns nothing for an empty query', () => {
    expect(searchSettings('   ', t)).toEqual([]);
  });

  it('finds a pane by its name without listing every section under it', () => {
    expect(shape('recording')).toContainEqual(['recording', []]);
  });

  it('lands on a section named by a keyword', () => {
    expect(shape('dictation')).toContainEqual(['recording', ['recordingDictation']]);
  });

  it('narrows to a section when the pane and section are both named', () => {
    expect(shape('recording noise')).toEqual([['recording', ['recordingMicrophone']]]);
  });

  it('ignores accents and case, in French', () => {
    expect(shape('DICTEE', tFr)).toContainEqual(['recording', ['recordingDictation']]);
    expect(shape('cle api', tFr).map(([pane]) => pane)).toContain('aiProviders');
  });

  it('matches the start of a word, never its middle', () => {
    expect(shape('ai').map(([pane]) => pane)).not.toContain('backups');
    expect(shape('ai')).not.toContainEqual(['recording', ['recordingMicrophone']]);
    // About answers "ia" through its AI section, never through "confidentialité".
    expect(shape('ia', tFr)).toContainEqual(['about', ['aboutAi']]);
    expect(shape('ai').map(([pane]) => pane)).toContain('aiProviders');
  });

  it('finds the Trash retention under Backups', () => {
    expect(shape('trash')).toContainEqual(['backups', ['backupsRetention']]);
    expect(shape('corbeille', tFr)).toContainEqual(['backups', ['backupsRetention']]);
  });

  it('says nothing when nothing matches', () => {
    expect(searchSettings('zzzz', t)).toEqual([]);
  });
});
