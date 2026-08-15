/**
 * Task writes.
 *
 * Same shape as the rest of the command layer: validate at the trust boundary,
 * write through the adapter, then refresh the read cache. The Tasks view, the
 * inspector, the MCP server and the in-app agent all come through here, which is
 * what makes an agent-created assignment indistinguishable from a typed one.
 *
 * Two rules live in this file rather than in SQL, because they are decisions
 * rather than integrity constraints: subtasks are one level deep, and completing
 * a recurring task rolls it forward instead of closing it.
 */
import { z } from 'zod';
import { library } from '@/lib/adapters';
import type { TaskQuery } from '@/lib/adapters';
import {
  createTask,
  RecurrenceSchema,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
} from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { nextOccurrenceAfter, shiftReminder } from '@/lib/tasks/recurrence';
import {
  cancelledIfRequested,
  fail,
  ok,
  USER,
  type CommandContext,
  type CommandResult,
} from './types';

async function refreshTasks(): Promise<void> {
  await useLibraryStore.getState().refreshTasks();
}

const isoDateTime = z.string().datetime({ offset: true });

const CreateTaskInput = z.object({
  title: z.string().trim().min(1).max(500),
  details: z.string().max(10_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  courseId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  dueAt: isoDateTime.nullable().optional(),
  remindAt: isoDateTime.nullable().optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  /** Notes to link the new task to, as `manual` links. */
  noteIds: z.array(z.string()).optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

export async function createTaskCommand(
  input: CreateTaskInput,
  context: CommandContext = USER,
): Promise<CommandResult<Task>> {
  const cancelled = cancelledIfRequested<Task>(context);
  if (cancelled) return cancelled;
  const parsed = CreateTaskInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid task input', parsed.error.issues);
  }

  const { noteIds, parentId, ...fields } = parsed.data;

  if (parentId) {
    const parent = await library.getTask(parentId);
    if (!parent) return fail('not_found', `no task ${parentId}`);
    // One level only. A tree of arbitrary depth is a different feature, and
    // every consumer — the list, the cascade rules, the MCP payload — would
    // have to learn about it.
    if (parent.parentId) {
      return fail('invalid_input', 'a subtask cannot have subtasks of its own');
    }
    // A recurring parent would roll forward and leave its children behind on a
    // date that no longer means anything.
    if (fields.recurrence) {
      return fail('invalid_input', 'only a top-level task can repeat');
    }
  }

  const task = createTask({ ...fields, parentId: parentId ?? null });

  try {
    await library.upsertTask(task);
    if (noteIds?.length) await library.setTaskNoteLinks(task.id, noteIds);
  } catch (error) {
    return fail('storage_failed', String(error));
  }

  await refreshTasks().catch(() => {});
  return ok(task);
}

const UpdateTaskInput = z.object({
  taskId: z.string().min(1),
  /**
   * Optimistic-concurrency guard used by external writers. When supplied, the
   * write only lands if the task is still the version the caller read.
   */
  baseUpdatedAt: z.string().datetime({ offset: true }).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  details: z.string().max(10_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  courseId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  dueAt: isoDateTime.nullable().optional(),
  remindAt: isoDateTime.nullable().optional(),
  remindedAt: isoDateTime.nullable().optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  order: z.number().int().nonnegative().optional(),
});
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;

/** The refresh-free half, so a bulk caller can write N tasks and refresh once. */
export async function applyTaskUpdate(
  input: UpdateTaskInput,
  context: CommandContext = USER,
): Promise<CommandResult<Task>> {
  const cancelled = cancelledIfRequested<Task>(context);
  if (cancelled) return cancelled;
  const parsed = UpdateTaskInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid task input', parsed.error.issues);
  }

  const existing = await library.getTask(parsed.data.taskId);
  if (!existing) return fail('not_found', `no task ${parsed.data.taskId}`);

  if (parsed.data.parentId) {
    if (parsed.data.parentId === existing.id) {
      return fail('invalid_input', 'a task cannot be its own parent');
    }
    const parent = await library.getTask(parsed.data.parentId);
    if (!parent) return fail('not_found', `no task ${parsed.data.parentId}`);
    if (parent.parentId) {
      return fail('invalid_input', 'a subtask cannot have subtasks of its own');
    }
    // Re-parenting a task that already has children would create depth 2 from
    // the other direction, which the check above cannot see.
    const children = await library.listTasks({ parentId: existing.id, scope: 'all' });
    if (children.length) {
      return fail('invalid_input', 'a task with subtasks cannot become one');
    }
  }

  // Optional fields passed explicitly as `undefined` must not overwrite the
  // persisted value, so each is copied only when present. An object spread
  // would turn a partial update into a malformed task.
  const patch: Partial<Task> = {};
  if (parsed.data.title !== undefined) patch.title = parsed.data.title;
  if (parsed.data.details !== undefined) patch.details = parsed.data.details;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
  if (parsed.data.courseId !== undefined) patch.courseId = parsed.data.courseId;
  if (parsed.data.parentId !== undefined) patch.parentId = parsed.data.parentId;
  if (parsed.data.tagIds !== undefined) patch.tagIds = parsed.data.tagIds;
  if (parsed.data.dueAt !== undefined) patch.dueAt = parsed.data.dueAt;
  if (parsed.data.remindAt !== undefined) patch.remindAt = parsed.data.remindAt;
  if (parsed.data.remindedAt !== undefined) patch.remindedAt = parsed.data.remindedAt;
  if (parsed.data.recurrence !== undefined) patch.recurrence = parsed.data.recurrence;
  if (parsed.data.order !== undefined) patch.order = parsed.data.order;

  if (patch.recurrence && (patch.parentId ?? existing.parentId)) {
    return fail('invalid_input', 'only a top-level task can repeat');
  }

  // Moving a reminder is the student saying "tell me then", so the delivery
  // stamp is cleared and the reminder becomes eligible again.
  if (patch.remindAt !== undefined && patch.remindAt !== existing.remindAt) {
    patch.remindedAt = parsed.data.remindedAt ?? null;
  }

  // `completedAt` is derived from status rather than settable, so the two can
  // never disagree about whether a task is done.
  if (patch.status !== undefined && patch.status !== existing.status) {
    patch.completedAt = patch.status === 'done' ? new Date().toISOString() : null;
  }

  const updated: Task = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  try {
    const baseUpdatedAt = parsed.data.baseUpdatedAt ?? existing.updatedAt;
    const saved = await library.upsertTaskIfUnchanged(updated, baseUpdatedAt);
    if (!saved) {
      const current = await library.getTask(existing.id);
      return fail('conflict', 'the task changed after it was read', {
        expectedUpdatedAt: baseUpdatedAt,
        actualUpdatedAt: current?.updatedAt,
      });
    }
  } catch (error) {
    return fail('storage_failed', String(error));
  }

  return ok(updated);
}

export async function updateTaskCommand(
  input: UpdateTaskInput,
  context: CommandContext = USER,
): Promise<CommandResult<Task>> {
  const result = await applyTaskUpdate(input, context);
  await refreshTasks();
  return result;
}

const CompleteTaskInput = z.object({
  taskId: z.string().min(1),
  baseUpdatedAt: z.string().datetime({ offset: true }).optional(),
  /** `false` reopens a completed task. */
  done: z.boolean().default(true),
});
export type CompleteTaskInput = z.input<typeof CompleteTaskInput>;

/**
 * Tick a task off.
 *
 * Separate from `updateTaskCommand` because two things happen here that a plain
 * status write must not do: completing a parent closes its subtasks, and
 * completing a recurring task rolls it forward rather than closing it.
 */
export async function completeTaskCommand(
  input: CompleteTaskInput,
  context: CommandContext = USER,
): Promise<CommandResult<Task>> {
  const cancelled = cancelledIfRequested<Task>(context);
  if (cancelled) return cancelled;
  const parsed = CompleteTaskInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid task input', parsed.error.issues);
  }

  const existing = await library.getTask(parsed.data.taskId);
  if (!existing) return fail('not_found', `no task ${parsed.data.taskId}`);

  const now = new Date().toISOString();
  let updated: Task;

  if (parsed.data.done && existing.recurrence) {
    const nextDueAt = nextOccurrenceAfter(existing.dueAt ?? now, existing.recurrence, now);
    updated = {
      ...existing,
      // Deliberately still `todo`: the occurrence was completed, the task was
      // not. `lastCompletedAt` is the record that it happened.
      status: 'todo',
      completedAt: null,
      lastCompletedAt: now,
      dueAt: nextDueAt,
      remindAt: shiftReminder(existing.remindAt, existing.dueAt, nextDueAt),
      remindedAt: null,
      updatedAt: now,
    };
  } else {
    updated = {
      ...existing,
      status: parsed.data.done ? 'done' : 'todo',
      completedAt: parsed.data.done ? now : null,
      lastCompletedAt: parsed.data.done ? now : existing.lastCompletedAt,
      updatedAt: now,
    };
  }

  try {
    const baseUpdatedAt = parsed.data.baseUpdatedAt ?? existing.updatedAt;
    const saved = await library.upsertTaskIfUnchanged(updated, baseUpdatedAt);
    if (!saved) {
      const current = await library.getTask(existing.id);
      return fail('conflict', 'the task changed after it was read', {
        expectedUpdatedAt: baseUpdatedAt,
        actualUpdatedAt: current?.updatedAt,
      });
    }

    // Closing a parent closes what it was broken into. A non-recurring parent
    // only; a recurring one stayed open above and its children go with it.
    if (!existing.parentId && !(parsed.data.done && existing.recurrence)) {
      const children = await library.listTasks({ parentId: existing.id, scope: 'live' });
      for (const child of children) {
        if ((child.status === 'done') === parsed.data.done) continue;
        await library.upsertTask({
          ...child,
          status: parsed.data.done ? 'done' : 'todo',
          completedAt: parsed.data.done ? now : null,
          lastCompletedAt: parsed.data.done ? now : child.lastCompletedAt,
          updatedAt: now,
        });
      }
    }
  } catch (error) {
    return fail('storage_failed', String(error));
  }

  await refreshTasks();
  return ok(updated);
}

export async function trashTasksCommand(
  taskIds: string[],
  context: CommandContext = USER,
): Promise<CommandResult<number>> {
  const cancelled = cancelledIfRequested<number>(context);
  if (cancelled) return cancelled;
  if (!taskIds.length) return fail('invalid_input', 'nothing to trash');

  try {
    await library.trashTasks(taskIds);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
  await refreshTasks();
  return ok(taskIds.length);
}

export async function restoreTasksCommand(
  taskIds: string[],
  context: CommandContext = USER,
): Promise<CommandResult<number>> {
  const cancelled = cancelledIfRequested<number>(context);
  if (cancelled) return cancelled;
  if (!taskIds.length) return fail('invalid_input', 'nothing to restore');

  try {
    await library.restoreTasks(taskIds);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
  await refreshTasks();
  return ok(taskIds.length);
}

/**
 * Empty the task half of Trash, on the same retention the note half uses. Not
 * reachable from MCP — permanent deletion is the app's alone.
 */
export async function purgeTrashedTasksCommand(): Promise<CommandResult<number>> {
  const { trashRetentionDays } = useSettingsStore.getState().settings;
  const cutoff = new Date(Date.now() - trashRetentionDays * 86_400_000).toISOString();
  try {
    const removed = await library.purgeTrashedTasks(cutoff);
    await refreshTasks();
    return ok(removed);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}

const LinkTaskInput = z.object({
  taskId: z.string().min(1),
  noteId: z.string().min(1),
  /** `false` detaches. Only `manual` links are ever touched. */
  linked: z.boolean().default(true),
});
export type LinkTaskInput = z.input<typeof LinkTaskInput>;

export async function linkTaskToNoteCommand(
  input: LinkTaskInput,
  context: CommandContext = USER,
): Promise<CommandResult<string[]>> {
  const cancelled = cancelledIfRequested<string[]>(context);
  if (cancelled) return cancelled;
  const parsed = LinkTaskInput.safeParse(input);
  if (!parsed.success) {
    return fail('invalid_input', 'invalid link input', parsed.error.issues);
  }

  const task = await library.getTask(parsed.data.taskId);
  if (!task) return fail('not_found', `no task ${parsed.data.taskId}`);
  const note = await library.getNote(parsed.data.noteId);
  if (!note) return fail('not_found', `no note ${parsed.data.noteId}`);

  const links = await library.listTaskNoteLinks();
  const manual = links
    .filter((link) => link.taskId === task.id && link.origin === 'manual')
    .map((link) => link.noteId);
  const next = parsed.data.linked
    ? [...new Set([...manual, note.id])]
    : manual.filter((noteId) => noteId !== note.id);

  try {
    await library.setTaskNoteLinks(task.id, next);
  } catch (error) {
    return fail('storage_failed', String(error));
  }
  await refreshTasks();
  return ok(next);
}

/** Reorder tasks within a manual list. One write per task, one refresh. */
export async function reorderTasksCommand(
  orderedIds: string[],
  context: CommandContext = USER,
): Promise<CommandResult<number>> {
  const cancelled = cancelledIfRequested<number>(context);
  if (cancelled) return cancelled;

  for (const [index, taskId] of orderedIds.entries()) {
    const result = await applyTaskUpdate({ taskId, order: index }, context);
    if (!result.ok) {
      await refreshTasks();
      return result;
    }
  }
  await refreshTasks();
  return ok(orderedIds.length);
}

/** Read helper shared by the Tasks view and the agent's `list_tasks`. */
export async function listTasksCommand(
  query: TaskQuery = {},
  context: CommandContext = USER,
): Promise<CommandResult<Task[]>> {
  const cancelled = cancelledIfRequested<Task[]>(context);
  if (cancelled) return cancelled;
  try {
    return ok(await library.listTasks(query));
  } catch (error) {
    return fail('storage_failed', String(error));
  }
}
