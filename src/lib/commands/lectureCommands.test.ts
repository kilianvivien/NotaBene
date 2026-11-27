import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { library, notifications } from '@/lib/adapters';
import i18n from '@/lib/i18n';
import { createCourse, type Course, type CourseMeeting } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLectureStore } from '@/lib/state/lectureStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useRecordingStore } from '@/lib/state/recordingStore';
import { useUiStore } from '@/lib/state/uiStore';
import { resetLectureClock, sweepLectures } from '@/lib/timetable/lectureClock';
import { currentMeeting } from '@/lib/timetable/meetings';
import { lectureTitle, startLectureCommand } from './lectureCommands';

const session: CourseMeeting = {
  id: 'm-1',
  title: null,
  weekdays: [1],
  start: 10 * 60,
  end: 11 * 60 + 30,
  location: 'Amphi B',
  from: '2026-11-30',
  until: '2026-11-30',
  skip: [],
  templateId: null,
  importKey: null,
};
/** Monday 30 November 2026, 10:05 local. */
const during = new Date(2026, 10, 30, 10, 5);

function droit(patch: Partial<Course> = {}): Course {
  return createCourse({
    id: 'c-1',
    name: 'Droit constitutionnel',
    meetings: [session],
    ...patch,
  });
}

beforeEach(async () => {
  memoryLibraryAdapter.reset();
  resetLectureClock();
  await i18n.changeLanguage('fr');
  vi.spyOn(useEditorStore.getState(), 'openNote').mockResolvedValue();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage('en');
});

async function withCourse(course: Course) {
  await library.upsertCourse(course);
  await useLibraryStore.getState().refreshCourses();
  return currentMeeting([course], during);
}

describe('startLectureCommand', () => {
  it('creates today’s note once, titled after the course and the day', async () => {
    const occurrence = await withCourse(droit());
    const first = await startLectureCommand(occurrence);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.created).toBe(true);
    const note = await library.getNote(first.value.noteId);
    expect(note?.title).toBe('Droit constitutionnel — lundi 30 novembre');
    expect(note?.lectureKey).toBe('m-1:2026-11-30');
    expect(note?.courseId).toBe('c-1');

    // Renamed, it is still today's lecture.
    await library.upsertNote({ ...note!, title: 'Mes notes' });
    const again = await startLectureCommand(occurrence);
    if (!again.ok) throw new Error(again.message);
    expect(again.value).toMatchObject({ noteId: first.value.noteId, created: false });
  });

  it('titles a session after itself, and starts from the course’s template', async () => {
    await library.upsertTemplate({
      id: 't-1',
      name: 'Cours',
      courseId: 'c-1',
      titlePattern: '',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Plan' }],
          },
        ],
      },
      tagIds: [],
    });
    await useLibraryStore.getState().refreshTemplates();
    const occurrence = await withCourse(
      droit({ meetings: [{ ...session, title: 'Conférence sur la corruption' }] }),
    );
    expect(lectureTitle(occurrence!)).toBe(
      'Conférence sur la corruption — lundi 30 novembre',
    );
    const result = await startLectureCommand(occurrence);
    if (!result.ok) throw new Error(result.message);
    const note = await library.getNote(result.value.noteId);
    expect(note?.plainText).toContain('Plan');
  });

  it('files the note in the section on screen, if it is the course’s', async () => {
    const occurrence = await withCourse(droit());
    useUiStore.setState({ view: { kind: 'course', courseId: 'c-1', sectionId: 's-12' } });
    const result = await startLectureCommand(occurrence);
    if (!result.ok) throw new Error(result.message);
    expect((await library.getNote(result.value.noteId))?.sectionId).toBe('s-12');
    useUiStore.setState({ view: { kind: 'all' } });
  });

  it('leaves the microphone alone when the course says ask', async () => {
    const start = vi.spyOn(useRecordingStore.getState(), 'start');
    start.mockResolvedValue({ ok: true, value: undefined });
    vi.spyOn(useEditorStore, 'getState').mockReturnValue({
      ...useEditorStore.getState(),
      note: { id: 'x', title: 'x' } as never,
    });
    const asked = await startLectureCommand(await withCourse(droit()));
    expect(asked.ok && asked.value.recording).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it('says there is no lecture rather than guessing', async () => {
    const result = await startLectureCommand(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});

describe('the lecture clock', () => {
  it('shows the meeting ten minutes ahead, then as started', async () => {
    await withCourse(droit());
    sweepLectures(new Date(2026, 10, 30, 9, 52));
    expect(useLectureStore.getState()).toMatchObject({ started: false });
    expect(useLectureStore.getState().current?.course.id).toBe('c-1');
    sweepLectures(new Date(2026, 10, 30, 10, 0));
    expect(useLectureStore.getState().started).toBe(true);
    sweepLectures(new Date(2026, 10, 30, 11, 30));
    expect(useLectureStore.getState().current).toBeNull();
  });

  it('notifies once, only when asked, and never catches up', async () => {
    const notify = vi.spyOn(notifications, 'notify').mockResolvedValue();
    await withCourse(droit());
    sweepLectures(new Date(2026, 10, 30, 9, 55));
    expect(notify).not.toHaveBeenCalled();

    await withCourse(droit({ lectureNotify: true }));
    resetLectureClock();
    // Opening the app at 10:30: the lecture is on, but it is not news.
    sweepLectures(new Date(2026, 10, 30, 10, 30));
    expect(notify).not.toHaveBeenCalled();

    resetLectureClock();
    sweepLectures(new Date(2026, 10, 30, 9, 55));
    sweepLectures(new Date(2026, 10, 30, 9, 55, 30));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
