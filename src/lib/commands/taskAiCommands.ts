/**
 * The AI half of tasks: plan the work, or read the notes and say whether it
 * looks done.
 *
 * Beside `taskCommands.ts` rather than inside it for the reason `studyCommands`
 * sits beside `aiCommands`: producing a proposal is not a mutation, and the two
 * writes these end in — subtasks created, a task completed — go through the
 * ordinary task commands, so a planned subtask is indistinguishable from a
 * typed one and completing from a verdict still rolls a recurrence forward.
 */
import { library } from '@/lib/adapters';
import {
  requestTaskBreakdown,
  requestTaskCheck,
  type AiRunOptions,
  type SubtaskDraft,
  type TaskCheckResult,
} from '@/lib/ai';
import type { Note, Task } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { aiFailure, language, providerFor, sourceLimitFailure } from './aiCommands';
import { createTaskCommand } from './taskCommands';
import { fail, ok, type CommandResult } from './types';

/**
 * The notes attached to a task, in the order they were linked.
 *
 * Flushed first, for the same reason rewrite flushes: autosave debounces by
 * 800 ms, and checking a task against the note the student finished writing a
 * moment ago should check what they just wrote.
 */
async function linkedNotes(taskId: string): Promise<Note[]> {
  await useEditorStore.getState().flush();
  const links = useLibraryStore
    .getState()
    .taskNoteLinks.filter((link) => link.taskId === taskId);
  const notes: Note[] = [];
  for (const link of links) {
    const note = await library.getNote(link.noteId);
    if (note) notes.push(note);
  }
  return notes;
}

function courseNameOf(task: Task): string | null {
  if (!task.courseId) return null;
  const course = useLibraryStore
    .getState()
    .courses.find((entry) => entry.id === task.courseId);
  return course?.name ?? null;
}

async function subject(taskId: string): Promise<Task | null> {
  return library.getTask(taskId);
}

/**
 * Suggest the steps a task breaks into. Writes nothing.
 *
 * Runs with or without linked notes: a title and a deadline are enough to plan
 * from, and a button that refuses until something is linked would be disabled
 * on exactly the tasks a student most wants help with.
 */
export async function proposeSubtasksCommand(
  taskId: string,
  options: AiRunOptions = {},
): Promise<CommandResult<SubtaskDraft[]>> {
  const task = await subject(taskId);
  if (!task) return fail('not_found', `no task ${taskId}`);
  if (task.parentId) return fail('invalid_input', 'a subtask cannot have subtasks');

  const notes = await linkedNotes(taskId);
  const over = sourceLimitFailure<SubtaskDraft[]>(notes);
  if (over) return over;

  const lookup = await providerFor('tasks');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  const existing = useLibraryStore
    .getState()
    .tasks.filter((entry) => entry.parentId === task.id && !entry.trashedAt)
    .map((entry) => entry.title);

  try {
    return ok(
      await requestTaskBreakdown(
        {
          provider: lookup.provider,
          task,
          courseName: courseNameOf(task),
          existingSubtasks: existing,
          sources: notes,
          language: language(),
        },
        options,
      ),
    );
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}

/**
 * Create the steps the student kept.
 *
 * One `createTaskCommand` each rather than a bulk write: there are at most a
 * handful, and the command is what enforces the one-level rule and refreshes
 * the read cache. The count comes back so the dialog can say what landed.
 */
export async function createSubtasksCommand(
  taskId: string,
  drafts: SubtaskDraft[],
): Promise<CommandResult<number>> {
  if (!drafts.length) return fail('invalid_input', 'nothing to create');
  const task = await subject(taskId);
  if (!task) return fail('not_found', `no task ${taskId}`);

  let created = 0;
  for (const draft of drafts) {
    const result = await createTaskCommand({
      title: draft.title,
      details: draft.details,
      priority: draft.priority,
      parentId: task.id,
      courseId: task.courseId,
      dueAt: draft.dueAt,
    });
    if (result.ok) created += 1;
  }
  // Every one refused means the write failed rather than the plan being empty,
  // and a silent "created 0" would look like the button did nothing.
  if (!created) return fail('storage_failed', 'no subtask could be created');
  return ok(created);
}

/**
 * Ask whether the linked notes suggest the task is finished. Writes nothing —
 * the verdict is an opinion, and ticking the task off stays the student's.
 */
export async function checkTaskAgainstNotesCommand(
  taskId: string,
  options: AiRunOptions = {},
): Promise<CommandResult<TaskCheckResult>> {
  const task = await subject(taskId);
  if (!task) return fail('not_found', `no task ${taskId}`);

  const notes = await linkedNotes(taskId);
  if (!notes.length) return fail('invalid_input', 'no notes are linked to this task');
  const over = sourceLimitFailure<TaskCheckResult>(notes);
  if (over) return over;

  const lookup = await providerFor('tasks');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    return ok(
      await requestTaskCheck(
        {
          provider: lookup.provider,
          task,
          courseName: courseNameOf(task),
          sources: notes,
          language: language(),
        },
        options,
      ),
    );
  } catch (error) {
    return aiFailure(error, options.signal);
  }
}
