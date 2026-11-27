import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCalendarImportCommand,
  applyTimetableImportCommand,
  readCalendarCommand,
} from '@/lib/commands';
import type { PlannedSession, TimetablePlan } from '@/lib/import/timetable';
import { createCourse, newId } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import i18n from '@/lib/i18n';
import { CalendarImportDialog } from './CalendarDialogs';

vi.mock('@/lib/commands', () => ({
  applyCalendarImportCommand: vi.fn(),
  applyTimetableImportCommand: vi.fn(),
  calendarExportTasks: vi.fn(() => ({ tasks: [], withoutDueDate: 0 })),
  exportCalendarCommand: vi.fn(),
  readCalendarCommand: vi.fn(),
}));

const droit = createCourse({ name: 'Droit public' });
const archived = createCourse({ name: 'Ancien cours', archived: true });

function session(
  status: PlannedSession['status'],
  existing: PlannedSession['existing'] = null,
): PlannedSession {
  return {
    importKey: `ics:${newId()}`,
    existing,
    status,
    meeting: {
      id: newId(),
      title: 'Séance',
      weekdays: [1],
      start: 9 * 60,
      end: 10 * 60,
      location: null,
      from: '2026-11-30',
      until: '2026-11-30',
      skip: [],
      templateId: null,
      importKey: null,
    },
  };
}

const timetable: TimetablePlan = {
  groups: [
    {
      key: 'droit public',
      label: 'Droit public',
      suggestedCourseId: droit.id,
      sessions: [session('new'), session('new')],
    },
    {
      key: 'economie',
      label: 'Économie',
      suggestedCourseId: null,
      sessions: [session('new')],
    },
    {
      key: 'histoire',
      label: 'Histoire',
      suggestedCourseId: archived.id,
      sessions: [
        session('unchanged', { courseId: archived.id, meetingId: newId() }),
        session('cancelled', { courseId: archived.id, meetingId: newId() }),
      ],
    },
    {
      key: '',
      label: null,
      suggestedCourseId: null,
      sessions: [session('new')],
    },
  ],
  skipped: [],
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  useLibraryStore.setState({ courses: [droit, archived] });
  vi.mocked(readCalendarCommand).mockResolvedValue({
    ok: true,
    value: {
      name: 'semaine.ics',
      plan: { tasks: [], skipped: [], warnings: [], overrides: 0 },
      timetable,
    },
  });
  vi.mocked(applyTimetableImportCommand).mockResolvedValue({
    ok: true,
    value: { added: 3, updated: 0, removed: 1, coursesCreated: 1 },
  });
  useUiStore.getState().setCalendarImportOpen(true);
});
afterEach(cleanup);

async function openFile() {
  render(<CalendarImportDialog />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose .ics file…' }));
  await screen.findByText('Timetable');
}

const select = (group: string) =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: `Course for ${group}` });

describe('CalendarImportDialog timetable', () => {
  it('maps each group to its suggested course, a new one, or nothing', async () => {
    await openFile();
    expect(select('Droit public').value).toBe(`course:${droit.id}`);
    expect(select('Économie').value).toBe('new');
    // No name to give a course: left out unless the student says otherwise.
    expect(select('Uncategorised').value).toBe('skip');
    expect(screen.queryByRole('option', { name: /New course “null”/ })).toBeNull();
    // Already imported: read-only, in the course it lives in, archived or not.
    expect(screen.queryByRole('combobox', { name: 'Course for Histoire' })).toBeNull();
    expect(screen.getByText('Ancien cours')).toBeTruthy();
    expect(screen.getByText('2 new')).toBeTruthy();
    expect(screen.getByText('1 cancelled')).toBeTruthy();
  });

  it('imports a sessions-only file with the chosen map, and says what it did', async () => {
    await openFile();
    fireEvent.change(select('Économie'), { target: { value: 'skip' } });
    fireEvent.change(select('Uncategorised'), {
      target: { value: `course:${droit.id}` },
    });
    // Two to Droit public, one from the uncategorised, one cancelled.
    fireEvent.click(screen.getByRole('button', { name: 'Import 4 sessions' }));

    await waitFor(() => expect(applyTimetableImportCommand).toHaveBeenCalledOnce());
    // Nothing selected among the tasks, so the task import is not run at all.
    expect(applyCalendarImportCommand).not.toHaveBeenCalled();
    const [plan, choices] = vi.mocked(applyTimetableImportCommand).mock.calls[0]!;
    expect(plan).toBe(timetable);
    expect([...choices.entries()]).toEqual([
      ['droit public', { kind: 'course', courseId: droit.id }],
      ['economie', { kind: 'skip' }],
      ['histoire', { kind: 'course', courseId: archived.id }],
      ['', { kind: 'course', courseId: droit.id }],
    ]);
    expect(
      await screen.findByText(
        '3 sessions added to 1 course. 1 cancelled session removed. 1 new course created.',
      ),
    ).toBeTruthy();
  });
});
