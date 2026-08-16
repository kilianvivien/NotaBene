import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '@/lib/schema';
import { groupFor, groupTasks, subtaskProgress, taskCounts } from './taskGrouping';

const now = new Date(2026, 7, 15, 12, 0, 0);

function task(overrides: Partial<Task> & { title: string }): Task {
  return createTask(overrides);
}

/** Local wall-clock, because that is the frame the bands are defined in. */
function at(day: number, hour = 12): string {
  return new Date(2026, 7, day, hour, 0, 0).toISOString();
}

describe('groupFor', () => {
  it('puts a task due earlier today in Overdue, not Today', () => {
    expect(groupFor(task({ title: 'a', dueAt: at(15, 9) }), now)).toBe('overdue');
  });

  it('keeps a task due later today in Today', () => {
    expect(groupFor(task({ title: 'a', dueAt: at(15, 18) }), now)).toBe('today');
  });

  it('does not call tomorrow morning "today" just because it is within a day', () => {
    // The band is the rest of the calendar day, not the next 24 hours.
    expect(groupFor(task({ title: 'a', dueAt: at(16, 9) }), now)).toBe('week');
  });

  it('separates this week from later', () => {
    expect(groupFor(task({ title: 'a', dueAt: at(21) }), now)).toBe('week');
    expect(groupFor(task({ title: 'a', dueAt: at(30) }), now)).toBe('later');
  });

  it('files an undated task apart from everything with a deadline', () => {
    expect(groupFor(task({ title: 'a' }), now)).toBe('noDate');
  });

  it('files a completed task under Done however overdue it was', () => {
    expect(groupFor(task({ title: 'a', dueAt: at(1), status: 'done' }), now)).toBe('done');
  });
});

describe('groupTasks', () => {
  it('drops empty bands and keeps the rest in order', () => {
    const groups = groupTasks(
      [
        task({ title: 'later', dueAt: at(30) }),
        task({ title: 'overdue', dueAt: at(2) }),
        task({ title: 'done', status: 'done' }),
      ],
      now,
    );

    expect(groups.map((group) => group.id)).toEqual(['overdue', 'later', 'done']);
  });

  it('leaves subtasks out, because the list nests them under their parent', () => {
    const parent = task({ title: 'Essay', dueAt: at(20) });
    const groups = groupTasks(
      [parent, task({ title: 'Outline', parentId: parent.id, dueAt: at(2) })],
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('week');
  });
});

describe('taskCounts', () => {
  it('counts open work and how much of it is late', () => {
    const counts = taskCounts(
      [
        task({ title: 'late', dueAt: at(2) }),
        task({ title: 'ahead', dueAt: at(30) }),
        task({ title: 'finished', dueAt: at(2), status: 'done' }),
        task({ title: 'binned', dueAt: at(2), trashedAt: at(3) }),
      ],
      now,
    );

    expect(counts).toEqual({ open: 2, overdue: 1 });
  });

  it('counts subtasks too — four late things are four late things', () => {
    const parent = task({ title: 'Essay', dueAt: at(2) });
    const counts = taskCounts(
      [parent, task({ title: 'Outline', parentId: parent.id, dueAt: at(2) })],
      now,
    );

    expect(counts).toEqual({ open: 2, overdue: 2 });
  });
});

describe('subtaskProgress', () => {
  it('reports how much of a parent is finished', () => {
    const parent = task({ title: 'Essay' });
    const tasks = [
      parent,
      task({ title: 'Outline', parentId: parent.id, status: 'done' }),
      task({ title: 'Draft', parentId: parent.id }),
      task({ title: 'Binned', parentId: parent.id, trashedAt: at(3) }),
    ];

    expect(subtaskProgress(tasks, parent.id)).toEqual({ done: 1, total: 2 });
  });
});
