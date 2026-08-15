import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { Recurrence } from '@/lib/schema';
import {
  completeTaskCommand,
  createTaskCommand,
  linkTaskToNoteCommand,
  restoreTasksCommand,
  trashTasksCommand,
  updateTaskCommand,
} from './taskCommands';

const weekly: Recurrence = { freq: 'weekly', interval: 1, weekdays: [] };

beforeEach(() => memoryLibraryAdapter.reset());

/** Unwrap a command result, failing loudly with its message if it errored. */
function value<T>(result: Awaited<ReturnType<typeof createTaskCommand>> | { ok: boolean }) {
  if (!result.ok) throw new Error(`command failed: ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

describe('createTaskCommand', () => {
  it('creates a task with the schema defaults', async () => {
    const result = await createTaskCommand({ title: 'Problem set 3' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect(result.value.priority).toBe('none');
    expect(result.value.trashedAt).toBeNull();
    expect(await memoryLibraryAdapter.getTask(result.value.id)).not.toBeNull();
  });

  it('refuses a blank title rather than storing an unreadable row', async () => {
    const result = await createTaskCommand({ title: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_input');
  });

  it('refuses a subtask of a subtask', async () => {
    const parent = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    const child = value<{ id: string }>(
      await createTaskCommand({ title: 'Outline', parentId: parent.id }),
    );

    const result = await createTaskCommand({ title: 'Bullet 1', parentId: child.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_input');
      expect(result.message).toMatch(/subtasks of its own/);
    }
  });

  it('refuses recurrence on a subtask', async () => {
    const parent = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));

    const result = await createTaskCommand({
      title: 'Weekly check-in',
      parentId: parent.id,
      recurrence: weekly,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/top-level/);
  });

  it('links the notes it was given', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    const task = value<{ id: string }>(
      await createTaskCommand({ title: 'Read chapter 4', noteIds: [note.id] }),
    );

    const links = await memoryLibraryAdapter.listTaskNoteLinks();
    expect(links).toEqual([{ taskId: task.id, noteId: note.id, origin: 'manual' }]);
  });
});

describe('updateTaskCommand', () => {
  it('leaves untouched fields alone on a partial update', async () => {
    const task = value<{ id: string }>(
      await createTaskCommand({
        title: 'Essay',
        details: 'Three thousand words',
        priority: 'high',
      }),
    );

    const result = await updateTaskCommand({ taskId: task.id, title: 'Essay, final' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Essay, final');
    expect(result.value.details).toBe('Three thousand words');
    expect(result.value.priority).toBe('high');
  });

  it('derives completedAt from status so the two cannot disagree', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));

    const done = await updateTaskCommand({ taskId: task.id, status: 'done' });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.value.completedAt).not.toBeNull();

    const reopened = await updateTaskCommand({ taskId: task.id, status: 'todo' });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value.completedAt).toBeNull();
  });

  it('makes a moved reminder eligible to fire again', async () => {
    const task = value<{ id: string; updatedAt: string }>(
      await createTaskCommand({
        title: 'Hand in essay',
        remindAt: '2026-08-15T07:00:00.000Z',
      }),
    );
    await updateTaskCommand({ taskId: task.id, remindedAt: '2026-08-15T07:00:00.000Z' });

    const moved = await updateTaskCommand({
      taskId: task.id,
      remindAt: '2026-08-16T07:00:00.000Z',
    });

    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.value.remindedAt).toBeNull();
  });

  it('rejects a write whose base version has moved', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    await updateTaskCommand({ taskId: task.id, title: 'Essay, revised' });

    // An explicitly old stamp rather than the one `createTaskCommand` returned:
    // `updatedAt` has millisecond resolution, and in a test both writes land
    // inside the same millisecond. This asserts the guard, not the clock.
    const stale = await updateTaskCommand({
      taskId: task.id,
      title: 'Essay, from a stale reader',
      baseUpdatedAt: '2020-01-01T00:00:00.000Z',
    });

    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('conflict');
    const stored = await memoryLibraryAdapter.getTask(task.id);
    expect(stored?.title).toBe('Essay, revised');
  });

  it('refuses to make a task its own parent', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    const result = await updateTaskCommand({ taskId: task.id, parentId: task.id });
    expect(result.ok).toBe(false);
  });

  it('refuses to demote a task that already has subtasks', async () => {
    const parent = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    const other = value<{ id: string }>(await createTaskCommand({ title: 'Revision' }));
    await createTaskCommand({ title: 'Outline', parentId: parent.id });

    const result = await updateTaskCommand({ taskId: parent.id, parentId: other.id });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/subtasks cannot become one/);
  });
});

describe('completeTaskCommand', () => {
  it('closes a plain task', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));

    const result = await completeTaskCommand({ taskId: task.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('done');
    expect(result.value.completedAt).not.toBeNull();
  });

  it('closes the subtasks a parent was broken into', async () => {
    const parent = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    await createTaskCommand({ title: 'Outline', parentId: parent.id });
    await createTaskCommand({ title: 'Draft', parentId: parent.id });

    await completeTaskCommand({ taskId: parent.id });

    const children = await memoryLibraryAdapter.listTasks({ parentId: parent.id });
    expect(children.map((child) => child.status)).toEqual(['done', 'done']);
  });

  it('rolls a recurring task forward instead of closing it', async () => {
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const task = value<{ id: string }>(
      await createTaskCommand({ title: 'Problem set', dueAt, recurrence: weekly }),
    );

    const result = await completeTaskCommand({ taskId: task.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect(result.value.completedAt).toBeNull();
    expect(result.value.lastCompletedAt).not.toBeNull();
    expect(result.value.dueAt).not.toBeNull();
    expect(new Date(result.value.dueAt as string).getTime()).toBeGreaterThan(
      new Date(dueAt).getTime(),
    );
  });

  it('clears the delivery stamp so the next occurrence reminds again', async () => {
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const remindAt = new Date(Date.now() - 3_600_000).toISOString();
    const task = value<{ id: string }>(
      await createTaskCommand({ title: 'Problem set', dueAt, remindAt, recurrence: weekly }),
    );
    await updateTaskCommand({ taskId: task.id, remindedAt: new Date().toISOString() });

    const result = await completeTaskCommand({ taskId: task.id });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.remindedAt).toBeNull();
  });

  it('reopens a task on request', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    await completeTaskCommand({ taskId: task.id });

    const result = await completeTaskCommand({ taskId: task.id, done: false });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('todo');
  });
});

describe('trash and restore', () => {
  it('takes subtasks to Trash with their parent and lifts them back', async () => {
    const parent = value<{ id: string }>(await createTaskCommand({ title: 'Essay' }));
    await createTaskCommand({ title: 'Outline', parentId: parent.id });

    await trashTasksCommand([parent.id]);
    expect(await memoryLibraryAdapter.listTasks({ scope: 'live' })).toHaveLength(0);

    await restoreTasksCommand([parent.id]);
    expect(await memoryLibraryAdapter.listTasks({ scope: 'live' })).toHaveLength(2);
  });

  it('refuses an empty selection rather than silently doing nothing', async () => {
    const result = await trashTasksCommand([]);
    expect(result.ok).toBe(false);
  });
});

describe('linkTaskToNoteCommand', () => {
  it('attaches and detaches a manual link', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Read chapter 4' }));

    await linkTaskToNoteCommand({ taskId: task.id, noteId: note.id });
    expect(await memoryLibraryAdapter.listTaskNoteLinks()).toHaveLength(1);

    await linkTaskToNoteCommand({ taskId: task.id, noteId: note.id, linked: false });
    expect(await memoryLibraryAdapter.listTaskNoteLinks()).toHaveLength(0);
  });

  it('reports a missing note rather than storing a dangling link', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Read chapter 4' }));
    const result = await linkTaskToNoteCommand({ taskId: task.id, noteId: 'no-such-note' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});

describe('inline mentions', () => {
  it('derives a link from a task chip in the note and drops it when removed', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Read chapter 4' }));
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });

    await memoryLibraryAdapter.upsertNote({
      ...note,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'taskRef', attrs: { taskId: task.id } }],
          },
        ],
      },
    });

    expect(await memoryLibraryAdapter.listTaskNoteLinks()).toEqual([
      { taskId: task.id, noteId: note.id, origin: 'mention' },
    ]);

    await memoryLibraryAdapter.upsertNote({
      ...note,
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    expect(await memoryLibraryAdapter.listTaskNoteLinks()).toEqual([]);
  });

  it('keeps a manual link after the chip is deleted from the prose', async () => {
    const task = value<{ id: string }>(await createTaskCommand({ title: 'Read chapter 4' }));
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    await linkTaskToNoteCommand({ taskId: task.id, noteId: note.id });

    await memoryLibraryAdapter.upsertNote({
      ...note,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'taskRef', attrs: { taskId: task.id } }],
          },
        ],
      },
    });
    await memoryLibraryAdapter.upsertNote({
      ...note,
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    const links = await memoryLibraryAdapter.listTaskNoteLinks();
    expect(links).toEqual([{ taskId: task.id, noteId: note.id, origin: 'manual' }]);
  });
});
