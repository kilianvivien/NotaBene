import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { parseIcs, planCalendarImport } from '@/lib/import/ics';
import { createTask } from '@/lib/schema';
import { applyCalendarImportCommand, calendarExportTasks } from './calendarCommands';

const now = new Date(2026, 0, 20, 12).toISOString();
const ics = (summary: string, day: string) =>
  [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:essay@moodle',
    `SUMMARY:${summary}`,
    `DTSTART:${day}T225900Z`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

beforeEach(() => memoryLibraryAdapter.reset());

describe('applyCalendarImportCommand', () => {
  it('creates tasks with provenance, then updates them from a newer copy', async () => {
    const first = planCalendarImport(parseIcs(ics('Essay due', '20990310')), [], now);
    const created = await applyCalendarImportCommand(first.tasks, { courseId: null });
    expect(created.ok && created.value).toEqual({ created: 1, updated: 0, unchanged: 0 });

    const [task] = await memoryLibraryAdapter.listTasks({ scope: 'all' });
    expect(task?.importKey).toBe('ics:essay@moodle');
    // The student files it and ticks a subtask's worth of progress.
    await memoryLibraryAdapter.upsertTask({ ...task!, priority: 'high' });

    const existing = await memoryLibraryAdapter.listTasks({ scope: 'all' });
    const second = planCalendarImport(
      parseIcs(ics('Essay due (extended)', '20990317')),
      existing,
      now,
    );
    const updated = await applyCalendarImportCommand(second.tasks, { courseId: null });
    expect(updated.ok && updated.value).toEqual({ created: 0, updated: 1, unchanged: 0 });

    const after = await memoryLibraryAdapter.listTasks({ scope: 'all' });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      title: 'Essay due (extended)',
      dueAt: '2099-03-17T22:59:00.000Z',
      priority: 'high',
    });
  });
});

describe('calendarExportTasks', () => {
  it('keeps open tasks of the scope and counts the undated ones', () => {
    const tasks = [
      createTask({ title: 'A', courseId: 'c1', dueAt: now }),
      createTask({ title: 'B', courseId: 'c1' }),
      createTask({ title: 'C', courseId: 'c2', dueAt: now }),
      createTask({ title: 'D', courseId: 'c1', dueAt: now, status: 'done' }),
    ];
    const chosen = calendarExportTasks(tasks, { courseId: 'c1' });
    expect(chosen.tasks.map((task) => task.title)).toEqual(['A']);
    expect(chosen.withoutDueDate).toBe(1);
    expect(calendarExportTasks(tasks, { includeDone: true }).tasks).toHaveLength(3);
  });
});
