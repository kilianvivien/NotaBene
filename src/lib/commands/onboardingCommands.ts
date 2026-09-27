/**
 * First run.
 *
 * A first run asks how to begin rather than assuming: someone arriving with
 * an Obsidian vault should spend their first minute importing it, not deleting
 * a sample course (plan §20 item 2). The choice is asked only of an empty
 * library — a library that already holds something, because it was moved here
 * or restored, has nothing to be welcomed into.
 *
 * The starter material is ordinary library data written through the same
 * commands as user-created courses and notes. It can therefore be edited,
 * exported, or deleted without any special-case cleanup.
 */
import { library } from '@/lib/adapters';
import i18n from '@/lib/i18n';
import { mindMapToSvg } from '@/lib/mindmap/layout';
import type { MindMap, NoteDoc } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { createCourseCommand } from './organizationCommands';
import { createNoteCommand } from './noteCommands';
import { fail, ok, type CommandResult } from './types';

const SAMPLE_DRAWING =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 260" width="720" height="260" role="img" aria-label="Study loop"><rect width="720" height="260" rx="16" fill="#fbfaf8"/><path d="M116 132 H286 M434 132 H604" stroke="#c17a47" stroke-width="4" marker-end="url(#a)"/><defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0 0 L0 6 L9 3 z" fill="#c17a47"/></marker></defs><g font-family="-apple-system,sans-serif" text-anchor="middle"><rect x="24" y="88" width="180" height="88" rx="14" fill="#fff" stroke="#3478c7" stroke-width="2"/><text x="114" y="138" font-size="20" fill="#1c1b19">Write</text><rect x="270" y="88" width="180" height="88" rx="14" fill="#fff" stroke="#4b7c58" stroke-width="2"/><text x="360" y="138" font-size="20" fill="#1c1b19">Connect</text><rect x="516" y="88" width="180" height="88" rx="14" fill="#fff" stroke="#7d5aa8" stroke-width="2"/><text x="606" y="138" font-size="20" fill="#1c1b19">Review</text></g></svg>';

function text(value: string) {
  return { type: 'text', text: value };
}

function starterMap(): MindMap {
  return {
    title: i18n.t('onboarding.mapTitle'),
    nodes: [
      { id: 'root', label: i18n.t('onboarding.mapRoot') },
      { id: 'write', label: i18n.t('onboarding.mapWrite') },
      { id: 'organize', label: i18n.t('onboarding.mapOrganize') },
      { id: 'review', label: i18n.t('onboarding.mapReview') },
    ],
    edges: [
      { from: 'root', to: 'write' },
      { from: 'root', to: 'organize' },
      { from: 'root', to: 'review' },
    ],
  };
}

function welcomeDoc(): NoteDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [text(i18n.t('onboarding.welcomeLead'))],
      },
      {
        type: 'callout',
        attrs: { kind: 'info' },
        content: [
          { type: 'paragraph', content: [text(i18n.t('onboarding.localCallout'))] },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [text(i18n.t('onboarding.tryTitle'))],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [
              { type: 'paragraph', content: [text(i18n.t('onboarding.trySlash'))] },
            ],
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [
              { type: 'paragraph', content: [text(i18n.t('onboarding.trySearch'))] },
            ],
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [
              { type: 'paragraph', content: [text(i18n.t('onboarding.tryPalette'))] },
            ],
          },
        ],
      },
      {
        type: 'drawing',
        attrs: {
          title: i18n.t('onboarding.drawingTitle'),
          data: { elements: [], appState: {}, files: {} },
          svg: SAMPLE_DRAWING,
        },
      },
    ],
  };
}

function studyDoc(): NoteDoc {
  const map = starterMap();
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [text(i18n.t('onboarding.studyLead'))] },
      { type: 'mindMap', attrs: { data: map, svg: mindMapToSvg(map), title: map.title } },
      {
        type: 'callout',
        attrs: { kind: 'important' },
        content: [{ type: 'paragraph', content: [text(i18n.t('onboarding.aiCallout'))] }],
      },
    ],
  };
}

/**
 * Whether to ask how to begin. An empty library whose first run is still open
 * says yes; a library with anything in it closes the first run quietly, so
 * the question never comes back once there is something to lose.
 */
export async function firstRunPendingCommand(): Promise<CommandResult<boolean>> {
  if (useSettingsStore.getState().settings.onboardingCompleted) return ok(false);
  try {
    const [notes, courses] = await Promise.all([
      library.countNotes({ scope: 'all' }),
      library.listCourses(),
    ]);
    if (notes === 0 && courses.length === 0) return ok(true);
    await useSettingsStore.getState().update({ onboardingCompleted: true });
    return ok(false);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

/** Close the first run without starter material — the student is importing
 * a library, or asked to start empty. */
export async function skipOnboardingCommand(): Promise<CommandResult<void>> {
  try {
    await useSettingsStore.getState().update({ onboardingCompleted: true });
    return ok(undefined);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

let onboardingRun: Promise<CommandResult<string | null>> | null = null;

async function performOnboarding(): Promise<CommandResult<string | null>> {
  const settings = useSettingsStore.getState().settings;
  if (settings.onboardingCompleted) return ok(null);

  const course = await createCourseCommand({
    name: i18n.t('onboarding.course'),
    icon: '🎓',
    color: '#c17a47',
  });
  if (!course.ok) return fail(course.code, course.message, course.details);

  const welcome = await createNoteCommand({
    courseId: course.value.id,
    title: i18n.t('onboarding.welcomeTitle'),
    doc: welcomeDoc(),
  });
  if (!welcome.ok) return fail(welcome.code, welcome.message, welcome.details);

  const study = await createNoteCommand({
    courseId: course.value.id,
    title: i18n.t('onboarding.studyTitle'),
    doc: studyDoc(),
  });
  if (!study.ok) return fail(study.code, study.message, study.details);

  try {
    await useSettingsStore.getState().update({ onboardingCompleted: true });
    useUiStore.getState().selectNote(welcome.value.id);
    await useEditorStore.getState().openNote(welcome.value.id);
    return ok(welcome.value.id);
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export function runOnboardingCommand(): Promise<CommandResult<string | null>> {
  if (!onboardingRun) {
    onboardingRun = performOnboarding().finally(() => {
      onboardingRun = null;
    });
  }
  return onboardingRun;
}
