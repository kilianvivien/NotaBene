/**
 * The two things a model can usefully do with a task: plan it, or read the
 * notes and say whether it looks finished.
 *
 * Neither writes anything. `taskAiCommands.ts` turns an accepted plan into
 * subtasks and a "done" verdict into a completion, which is what keeps the
 * guard the AI core is built on: a model's answer is parsed by a schema, the
 * student says yes, and only then does a command run.
 *
 * All the care in this file is about dates. The model answers in calendar days
 * because an instant from a model is a timezone bug — the same reason
 * `src/lib/tasks/recurrence.ts` does its arithmetic in local time — and this is
 * where a day becomes an instant: at the parent's own hour, so a plan for a
 * task due at 09:00 does not quietly land its steps at midnight UTC.
 */
import { docToMarkdown } from '@/editor/markdown';
import {
  AiTaskBreakdownResponseSchema,
  AiTaskCheckResponseSchema,
  type AiTaskCheckResponse,
  type Note,
  type Task,
  type TaskPriority,
} from '@/lib/schema';
import type { AiRunOptions } from './client';
import { taskBreakdownPrompt, taskCheckPrompt, type TaskPromptSubject } from './prompts';
import type { ResolvedProvider } from './protocols';
import { runStructured } from './structured';

/** How many steps to ask for. Past this a plan stops being a plan. */
const DEFAULT_STEP_COUNT = 6;

/** Where a step lands when the parent has no time of its own — the same hour
 * `GlassDateField` picks for a day chosen from the calendar. */
const DEFAULT_HOUR = 9;

/** A day in the student's own timezone, which is the only one they think in. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `YYYY-MM-DD` plus an hour, as a local instant.
 *
 * `new Date('2026-08-18')` is parsed as UTC midnight and would be the 17th for
 * anyone west of Greenwich, so the parts are handed to the constructor instead.
 */
function atLocalTime(day: string, hours: number, minutes: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hours,
    minutes,
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface SubtaskDraft {
  title: string;
  details?: string;
  /** ISO instant, or null when the step has no day of its own. */
  dueAt: string | null;
  priority: TaskPriority;
}

export interface TaskBreakdownRequest {
  provider: ResolvedProvider;
  task: Task;
  courseName: string | null;
  existingSubtasks: string[];
  /** Notes linked to the task. May be empty — a title and a deadline are
   * enough to plan from, and refusing to try without notes would make the
   * button useless on the tasks that most need it. */
  sources: Pick<Note, 'title' | 'doc'>[];
  count?: number;
  language: string;
}

export interface TaskCheckRequest {
  provider: ResolvedProvider;
  task: Task;
  courseName: string | null;
  sources: Pick<Note, 'title' | 'doc'>[];
  language: string;
}

export type TaskCheckResult = AiTaskCheckResponse;

function subject(
  task: Task,
  courseName: string | null,
  existingSubtasks: string[] = [],
): TaskPromptSubject {
  return {
    title: task.title,
    details: task.details,
    dueDate: task.dueAt ? localDay(new Date(task.dueAt)) : null,
    courseName,
    existingSubtasks,
  };
}

function markdownSources(
  sources: Pick<Note, 'title' | 'doc'>[],
): { title: string; markdown: string }[] {
  return sources.map((note) => ({
    title: note.title,
    markdown: docToMarkdown(note.doc),
  }));
}

/**
 * Turn a suggested day into an instant the task list can sort by.
 *
 * Two things are enforced here rather than trusted to the prompt, because both
 * produce a plan that is worse than no plan: a step due after the work itself,
 * and a step due before today. The first is clamped to the deadline — the model
 * had the right idea and the wrong arithmetic — and the second is dropped,
 * because a step the app would immediately paint as overdue is a lie about
 * where the student stands.
 */
export function resolveSubtaskDue(
  dueDate: string | undefined,
  parentDueAt: string | null,
  now: Date = new Date(),
): string | null {
  if (!dueDate) return null;
  const parent = parentDueAt ? new Date(parentDueAt) : null;
  const at = atLocalTime(
    dueDate,
    parent ? parent.getHours() : DEFAULT_HOUR,
    parent ? parent.getMinutes() : 0,
  );
  if (!at) return null;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at.getTime() < startOfToday.getTime()) return null;
  if (parent && at.getTime() > parent.getTime()) return parent.toISOString();
  return at.toISOString();
}

export async function requestTaskBreakdown(
  request: TaskBreakdownRequest,
  options: AiRunOptions = {},
): Promise<SubtaskDraft[]> {
  const now = new Date();
  const response = await runStructured(
    {
      provider: request.provider,
      messages: taskBreakdownPrompt({
        task: subject(request.task, request.courseName, request.existingSubtasks),
        sources: markdownSources(request.sources),
        today: localDay(now),
        count: request.count ?? DEFAULT_STEP_COUNT,
        language: request.language,
      }),
      maxTokens: 2_000,
      temperature: 0.3,
    },
    AiTaskBreakdownResponseSchema,
    options,
  );

  const seen = new Set(
    request.existingSubtasks.map((title) => title.trim().toLocaleLowerCase()),
  );
  const drafts: SubtaskDraft[] = [];
  for (const step of response.subtasks) {
    // A model asked not to repeat a step it was shown will still occasionally
    // repeat it. Dropping the duplicate costs one row; leaving it in costs the
    // student a list with the same step on it twice.
    const key = step.title.trim().toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      title: step.title.trim(),
      details: step.details?.trim() || undefined,
      dueAt: resolveSubtaskDue(step.dueDate, request.task.dueAt, now),
      priority: step.priority ?? 'none',
    });
  }
  return drafts;
}

export async function requestTaskCheck(
  request: TaskCheckRequest,
  options: AiRunOptions = {},
): Promise<TaskCheckResult> {
  if (!request.sources.length) {
    throw new Error('link a note to this task first');
  }
  const response = await runStructured(
    {
      provider: request.provider,
      messages: taskCheckPrompt({
        task: subject(request.task, request.courseName),
        sources: markdownSources(request.sources),
        today: localDay(new Date()),
        language: request.language,
      }),
      maxTokens: 1_200,
      temperature: 0.1,
    },
    AiTaskCheckResponseSchema,
    options,
  );

  // A quote attributed to a note that was not in the prompt is the shape a
  // fabricated citation takes. Drop it rather than showing the student a
  // source they cannot open.
  const titles = new Set(request.sources.map((note) => note.title));
  return {
    ...response,
    evidence: response.evidence.filter((entry) => titles.has(entry.noteTitle)),
  };
}
