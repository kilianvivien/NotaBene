/**
 * The task tool contract, in the shape `phaseF.test.ts` established.
 *
 * Handlers are called directly rather than through the Rust bridge: the bridge
 * carries bytes, and every decision worth pinning down is on this side of it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createCourseCommand } from '@/lib/commands';
import { TOOL_HANDLERS } from '@/lib/mcp/toolHandlers';
import type { CommandContext, CommandResult } from '@/lib/commands';
import type { Task } from '@/lib/schema';

const AGENT: CommandContext = { source: 'agent', agentName: 'contract-test' };
type Handler = (
  args: unknown,
  context: CommandContext,
) => Promise<CommandResult<unknown>>;

function call(method: keyof typeof TOOL_HANDLERS, args?: unknown) {
  return (TOOL_HANDLERS[method] as Handler)(args, AGENT);
}

async function createTask(args: Record<string, unknown>): Promise<Task> {
  const result = await call('create_task', args);
  if (!result.ok) throw new Error(result.message);
  return result.value as Task;
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('task tools', () => {
  it('creates a task and lists it back', async () => {
    const created = await createTask({ title: 'Problem set 3', priority: 'high' });

    const listed = await call('list_tasks', {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect((listed.value as Task[]).map((task) => task.id)).toEqual([created.id]);
    expect((listed.value as Task[])[0]?.priority).toBe('high');
  });

  it('refuses arguments it cannot read rather than guessing', async () => {
    const result = await call('create_task', { title: '' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects a stale update and leaves the task as it was', async () => {
    const task = await createTask({ title: 'Essay' });

    const landed = await call('update_task', {
      taskId: task.id,
      baseUpdatedAt: task.updatedAt,
      title: 'Essay, revised',
    });
    expect(landed.ok).toBe(true);

    const stale = await call('update_task', {
      taskId: task.id,
      baseUpdatedAt: '2020-01-01T00:00:00.000Z',
      title: 'Should not land',
    });
    expect(stale).toMatchObject({ ok: false, code: 'conflict' });
    expect((await library.getTask(task.id))?.title).toBe('Essay, revised');
  });

  it('extends task details without making the caller resend them', async () => {
    const task = await createTask({ title: 'Essay', details: 'Draft the argument.' });

    const updated = await call('update_task', {
      taskId: task.id,
      baseUpdatedAt: task.updatedAt,
      prependDetails: 'Read the primary source.',
      appendDetails: 'Proofread the citations.',
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect((updated.value as Task).details).toBe(
      'Read the primary source.\n\nDraft the argument.\n\nProofread the citations.',
    );
  });

  it('moves a task to recoverable Trash and restores it, through one tool', async () => {
    const task = await createTask({ title: 'Essay' });

    const trashed = await call('update_task', { taskId: task.id, trashed: true });
    expect(trashed.ok).toBe(true);
    expect(await library.listTasks({ scope: 'live' })).toHaveLength(0);
    expect(await library.listTasks({ scope: 'trashed' })).toHaveLength(1);

    const restored = await call('update_task', { taskId: task.id, trashed: false });
    expect(restored.ok).toBe(true);
    expect(await library.listTasks({ scope: 'live' })).toHaveLength(1);
  });

  it('takes subtasks to Trash with their parent', async () => {
    const parent = await createTask({ title: 'Essay' });
    await createTask({ title: 'Outline', parentId: parent.id });

    await call('update_task', { taskId: parent.id, trashed: true });

    expect(await library.listTasks({ scope: 'live' })).toHaveLength(0);
  });

  it('refuses a subtask of a subtask', async () => {
    const parent = await createTask({ title: 'Essay' });
    const child = await createTask({ title: 'Outline', parentId: parent.id });

    const result = await call('create_task', { title: 'Bullet', parentId: child.id });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rolls a repeating task forward instead of closing it', async () => {
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const task = await createTask({
      title: 'Problem set',
      dueAt,
      recurrence: { freq: 'weekly', interval: 1, weekdays: [] },
    });

    const completed = await call('complete_task', { taskId: task.id });

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const value = completed.value as Task;
    expect(value.status).toBe('todo');
    expect(value.lastCompletedAt).not.toBeNull();
    expect(new Date(value.dueAt as string).getTime()).toBeGreaterThan(
      new Date(dueAt).getTime(),
    );
  });

  it('closes a plain task and reopens it', async () => {
    const task = await createTask({ title: 'Essay' });

    const done = await call('complete_task', { taskId: task.id });
    expect((done as { value: Task }).value.status).toBe('done');

    const reopened = await call('complete_task', { taskId: task.id, done: false });
    expect((reopened as { value: Task }).value.status).toBe('todo');
  });

  it('links a task to a note and detaches it again', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Lecture 4' });
    const task = await createTask({ title: 'Read chapter 4' });

    const linked = await call('link_task_note', { taskId: task.id, noteId: note.id });
    expect(linked.ok).toBe(true);
    expect(await library.listTaskNoteLinks()).toHaveLength(1);

    const byNote = await call('list_tasks', { noteId: note.id });
    expect(((byNote as { value: Task[] }).value ?? []).map((entry) => entry.id)).toEqual([
      task.id,
    ]);

    const detached = await call('link_task_note', {
      taskId: task.id,
      noteId: note.id,
      linked: false,
    });
    expect(detached.ok).toBe(true);
    expect(await library.listTaskNoteLinks()).toHaveLength(0);
  });

  it('reports a missing note rather than storing a dangling link', async () => {
    const task = await createTask({ title: 'Read chapter 4' });
    const result = await call('link_task_note', {
      taskId: task.id,
      noteId: 'no-such-note',
    });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('files a task under a course and filters by it', async () => {
    const course = await createCourseCommand({ name: 'Analysis' });
    if (!course.ok) throw new Error(course.message);
    await createTask({ title: 'Problem set', courseId: course.value.id });
    await createTask({ title: 'Unrelated' });

    const filtered = await call('list_tasks', { courseId: course.value.id });
    expect(((filtered as { value: Task[] }).value ?? []).map((t) => t.title)).toEqual([
      'Problem set',
    ]);
  });

  /**
   * The negative surface, asserted the way `phaseF.test.ts` asserts it for
   * notes. Trash is the hard boundary: an agent may fill it and empty-handedly
   * ask for it back, but nothing here may destroy a deadline outright.
   */
  it('exposes no way to permanently delete a task', () => {
    expect(Object.keys(TOOL_HANDLERS)).not.toEqual(
      expect.arrayContaining([
        'delete_task',
        'delete_tasks',
        'purge_task',
        'purge_tasks',
        'empty_task_trash',
      ]),
    );
  });
});
