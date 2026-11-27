/**
 * The lecture starts (plan §4 item 2).
 *
 * `lecture.start` opens today's note for the meeting under way, creating it
 * the first time: from the meeting's template, else the course's own, titled
 * after the session (or the course) and the day, and keyed by
 * `{meetingId}:{day}` so a renamed note is still today's lecture.
 *
 * Where it goes: the section the student is looking at when it belongs to the
 * course — a student who keeps week sections is usually already in this
 * week's — and the course itself otherwise. None is created unasked.
 *
 * Whether it records is the course's choice: `always` starts the microphone,
 * `ask` leaves it ready and says so, `never` does neither.
 */
import i18n from '@/lib/i18n';
import { library } from '@/lib/adapters';
import type { Course, NoteTemplate } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLectureStore } from '@/lib/state/lectureStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useDictationStore } from '@/lib/state/dictationStore';
import { useUiStore } from '@/lib/state/uiStore';
import {
  lectureKey,
  parseLocalDay,
  type MeetingOccurrence,
} from '@/lib/timetable/meetings';
import { sweepLectures } from '@/lib/timetable/lectureClock';
import { createNotesCommand } from './noteCommands';
import { fail, ok, type CommandResult } from './types';

/** `Droit constitutionnel — lundi 30 novembre`, in the app's language. */
export function lectureTitle(
  occurrence: MeetingOccurrence,
  locale = i18n.language,
): string {
  const day = parseLocalDay(occurrence.day).toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return `${occurrence.meeting.title ?? occurrence.course.name} — ${day}`;
}

function templateFor(
  occurrence: MeetingOccurrence,
  templates: readonly NoteTemplate[],
): NoteTemplate | null {
  const { meeting, course } = occurrence;
  return (
    (meeting.templateId
      ? templates.find((template) => template.id === meeting.templateId)
      : undefined) ??
    templates.find((template) => template.courseId === course.id) ??
    null
  );
}

function sectionFor(course: Course): string | null {
  const view = useUiStore.getState().view;
  return view.kind === 'course' && view.courseId === course.id
    ? (view.sectionId ?? null)
    : null;
}

export interface StartedLecture {
  noteId: string;
  created: boolean;
  recording: boolean;
}

export async function startLectureCommand(
  occurrence: MeetingOccurrence | null = useLectureStore.getState().current ??
    sweepLectures(),
): Promise<CommandResult<StartedLecture>> {
  if (!occurrence) return fail('not_found', i18n.t('lecture.noneNow'));
  const key = lectureKey(occurrence.meeting.id, occurrence.day);

  let noteId: string | null;
  try {
    noteId = await library.findLectureNote(key);
  } catch (error) {
    return fail('storage_failed', String(error));
  }

  const created = !noteId;
  if (!noteId) {
    const template = templateFor(occurrence, useLibraryStore.getState().templates);
    const result = await createNotesCommand([
      {
        title: lectureTitle(occurrence),
        courseId: occurrence.course.id,
        sectionId: sectionFor(occurrence.course),
        doc: template?.doc,
        tagIds: template?.tagIds,
        lectureKey: key,
      },
    ]);
    if (!result.ok) return result;
    noteId = result.value[0]!.id;
  }

  useUiStore.getState().selectNote(noteId);
  await useEditorStore.getState().openNote(noteId);

  let recording = false;
  const mode = occurrence.course.lectureRecording;
  const idle =
    useRecordingStore.getState().status === 'idle' &&
    useDictationStore.getState().status === 'idle';
  if (mode === 'always' && idle) {
    const note = useEditorStore.getState().note;
    if (note?.id === noteId) {
      const started = await useRecordingStore.getState().start(note.id, note.title);
      recording = started.ok;
      if (!started.ok) useUiStore.getState().showStatusNotice(started.message);
    }
  } else if (mode === 'ask' && idle) {
    useUiStore.getState().showStatusNotice(i18n.t('lecture.readyToRecord'));
  }
  return ok({ noteId, created, recording });
}
