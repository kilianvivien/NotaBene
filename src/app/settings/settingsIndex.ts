/**
 * The one table behind the Settings nav and the Settings search (plan §4
 * item 0).
 *
 * Each pane lists the sections a search can land on. A section's `id` is also
 * the `anchor` its `FieldSection` (or hand-built `<section>`) carries in the
 * pane, which is how a hit scrolls to it. Labels are the keys the pane already
 * shows; the extra words a student might type instead — "micro", "clé",
 * "Anki" — live in the locales under `settingsSearch`, so French search is
 * written in French rather than translated from a list in code.
 *
 * A new pane or section is added here and nowhere else: the nav renders from
 * `SETTINGS_GROUPS`, and `settingsIndex.test.ts` fails if a tab is missing or a
 * key does not resolve in both locales.
 */
import {
  Bot,
  DatabaseBackup,
  HardDrive,
  Info,
  Mic,
  Palette,
  Replace,
  SlidersHorizontal,
  Sparkles,
  TextCursorInput,
  Type,
  Volume2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import type { SettingsTab } from '@/lib/state/uiStore';
import { fold } from '@/lib/search/fold';

export interface SettingsSectionEntry {
  /** The anchor the section carries in its pane. Unique across Settings. */
  id: string;
  /** The i18n key of the heading the pane shows for it. */
  titleKey: string;
}

export interface SettingsPaneEntry {
  id: SettingsTab;
  icon: LucideIcon;
  sections: SettingsSectionEntry[];
}

export interface SettingsGroupEntry {
  /** i18n key of the group heading. */
  labelKey: string;
  panes: SettingsPaneEntry[];
}

const section = (id: string, titleKey: string): SettingsSectionEntry => ({
  id,
  titleKey,
});

/** Nav groups, in the order they appear. */
export const SETTINGS_GROUPS: SettingsGroupEntry[] = [
  {
    labelKey: 'settings.groupApp',
    panes: [
      { id: 'general', icon: SlidersHorizontal, sections: [] },
      { id: 'appearance', icon: Palette, sections: [] },
      {
        id: 'editor',
        icon: Type,
        sections: [section('editorFocus', 'settings.focusSection')],
      },
      {
        id: 'completion',
        icon: TextCursorInput,
        sections: [
          section('completionSuggestions', 'settings.completionSuggestions'),
          section('completionSources', 'settings.completionSources'),
          section('completionKeyboard', 'settings.completionKeyboard'),
          section('completionKeys', 'settings.completionKeys'),
        ],
      },
      { id: 'abbreviations', icon: Replace, sections: [] },
    ],
  },
  {
    labelKey: 'settings.groupContent',
    panes: [
      {
        id: 'graph',
        icon: Waypoints,
        sections: [
          section('graphView', 'settings.graphView'),
          section('graphAi', 'settings.graphAi'),
        ],
      },
      {
        id: 'speech',
        icon: Volume2,
        sections: [
          section('speechEngine', 'speech.engineTitle'),
          section('speechLocal', 'speech.localTitle'),
          section('speechHosted', 'speech.hostedTitle'),
        ],
      },
      {
        id: 'recording',
        icon: Mic,
        sections: [
          section('recordingMicrophone', 'recordingSettings.microphoneSection'),
          section('recordingTranscription', 'recordingSettings.transcriptionSection'),
          section('recordingDictation', 'recordingSettings.dictationSection'),
        ],
      },
      {
        id: 'backups',
        icon: DatabaseBackup,
        sections: [
          section('backupsSchedule', 'backups.scheduleSection'),
          section('backupsRetention', 'backups.retentionSection'),
          section('backupsActions', 'settings.backupsActions'),
          section('backupsArchives', 'backups.archivesSection'),
        ],
      },
      // Backups are what NotaBene *does* with the data; this is what is
      // actually sitting on the disk right now. Two questions, two panes.
      {
        id: 'dataStorage',
        icon: HardDrive,
        sections: [
          section('storageImages', 'storage.imagesSection'),
          section('storageLocation', 'storage.locationSection'),
          section('storageSize', 'storage.sizeSection'),
          section('storageContents', 'storage.contentsSection'),
          section('storageIntegrity', 'storage.integritySection'),
        ],
      },
    ],
  },
  {
    labelKey: 'settings.groupConnections',
    panes: [
      {
        id: 'aiProviders',
        icon: Sparkles,
        sections: [
          section('aiProviderList', 'ai.providersSection'),
          section('aiFeatureModels', 'ai.featureModels'),
        ],
      },
      // The same robot the status bar lights up when an agent is editing.
      {
        id: 'agent',
        icon: Bot,
        sections: [
          section('agentInstructions', 'agent.instructions.title'),
          section('agentReview', 'agent.review.title'),
          section('agentReasoning', 'agent.reasoning.title'),
          section('agentServer', 'mcp.serverSection'),
          section('agentClients', 'mcp.clientSetup'),
          section('agentActivity', 'mcp.activityTitle'),
        ],
      },
    ],
  },
  {
    labelKey: 'settings.groupAbout',
    panes: [
      {
        id: 'about',
        icon: Info,
        sections: [
          section('aboutPrivacy', 'settings.aboutPrivacy'),
          section('aboutCredits', 'settings.aboutCredits'),
          section('aboutAi', 'settings.aboutAi'),
        ],
      },
    ],
  },
];

export const SETTINGS_PANES: SettingsPaneEntry[] = SETTINGS_GROUPS.flatMap(
  (group) => group.panes,
);

export const paneLabelKey = (tab: SettingsTab) => `settings.${tab}`;
export const paneKeywordsKey = (tab: SettingsTab) => `settingsSearch.${tab}`;
export const sectionKeywordsKey = (id: string) => `settingsSearch.section_${id}`;

export interface SettingsSearchHit {
  pane: SettingsPaneEntry;
  /** The sections the query names. Empty when only the pane itself matched. */
  sections: SettingsSectionEntry[];
}

type Translate = (key: string) => string;

/**
 * Every word of the query must begin a word somewhere in what is searched — a
 * pane's name and keywords, or a section's heading and keywords together
 * with its pane's. A section is listed only when it holds at least one word
 * itself, so "recording" lists the pane and not every section under it,
 * while "recording dictation" lists the one section.
 *
 * Folded the way search folds, so "securite" finds "Sécurité" and an
 * unaccented keyboard is not a handicap in French.
 */
export function searchSettings(query: string, t: Translate): SettingsSearchHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const hits: SettingsSearchHit[] = [];
  for (const pane of SETTINGS_PANES) {
    const paneWords = wordsOf(
      `${t(paneLabelKey(pane.id))} ${t(paneKeywordsKey(pane.id))}`,
    );
    const inPane = (word: string) => startsAWord(paneWords, word);
    const sections = pane.sections.filter((entry) => {
      const own = wordsOf(`${t(entry.titleKey)} ${t(sectionKeywordsKey(entry.id))}`);
      const inOwn = (word: string) => startsAWord(own, word);
      return words.some(inOwn) && words.every((word) => inOwn(word) || inPane(word));
    });
    if (words.every(inPane) || sections.length) hits.push({ pane, sections });
  }
  return hits;
}

const wordsOf = (text: string) =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** A query word matches the start of a word, never its middle: "ai" must not
 * find "daily" or "gain", nor "ia" find "confidentialité". */
const startsAWord = (haystack: string[], word: string) =>
  haystack.some((candidate) => candidate.startsWith(word));
