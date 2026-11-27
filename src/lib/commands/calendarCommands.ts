/**
 * Tasks to and from a calendar (plan §19).
 *
 * Export is a file, not a feed: a live subscription would need an HTTP
 * endpoint, and NotaBene's only listener is the authenticated MCP server,
 * which a calendar cannot authenticate to. Re-exporting replaces the events
 * instead, through stable `UID`s. Import is an importer in all but name —
 * read, plan, show, then write — and shares the notes' `import_key`
 * discipline, so next week's copy of a Moodle calendar updates the tasks it
 * made rather than doubling them.
 *
 * No MCP tool reaches either. Writing a file at an agent's request is what
 * made `export_write` a vulnerability once, and an agent can already create
 * tasks one at a time under its own ceilings.
 */
import { dialog, exporter, library } from '@/lib/adapters';
import { tasksToIcs, timetableToIcs } from '@/lib/export/ics';
import {
  IcsRefusal,
  parseIcs,
  planCalendarImport,
  type CalendarPlan,
  type PlannedCalendarTask,
} from '@/lib/import/ics';
import { CourseSchema, createTask, type Task } from '@/lib/schema';
import {
  applyTimetableChoices,
  planTimetableImport,
  type GroupChoice,
  type TimetablePlan,
} from '@/lib/import/timetable';
import { normalizeMeeting } from '@/lib/timetable/meetings';
import { createCourseCommand } from './organizationCommands';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { fail, ok, type CommandResult } from './types';

declare const __APP_VERSION__: string | undefined;

export interface CalendarExportScope {
  /** One course's tasks; `undefined` for every course (and the unfiled). */
  courseId?: string;
  /** Completed tasks too. Off by default: a calendar is for what is ahead. */
  includeDone?: boolean;
}

/** The tasks an export would contain, and how many have no date to put on a
 * calendar. A read, so the dialog can say both before anything is written. */
export function calendarExportTasks(
  tasks: readonly Task[],
  scope: CalendarExportScope,
): {
  tasks: Task[];
  withoutDueDate: number;
} {
  const chosen = tasks.filter(
    (task) =>
      !task.trashedAt &&
      (scope.courseId === undefined || task.courseId === scope.courseId) &&
      (scope.includeDone || task.status !== 'done'),
  );
  return {
    tasks: chosen.filter((task) => task.dueAt),
    withoutDueDate: chosen.filter((task) => !task.dueAt).length,
  };
}

function fileName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'NotaBene'}.ics`;
}

/**
 * A course's timetable — or every course's — as recurring events (plan §4
 * item 1). No dialog: unlike tasks there is nothing to choose, and the save
 * panel already says where it goes. `nothing_to_export` is returned as a code
 * so the surface can say it in the student's language.
 */
export async function exportTimetableCommand(
  courseId?: string,
  destination?: string,
): Promise<CommandResult<{ path?: string; exported: number }>> {
  try {
    const courses = (await library.listCourses()).filter(
      (course) => !course.archived && (courseId === undefined || course.id === courseId),
    );
    const calendarName =
      courseId !== undefined ? (courses[0]?.name ?? 'NotaBene') : 'NotaBene';
    const built = timetableToIcs(courses, {
      calendarName,
      appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
    });
    if (!built.exported) {
      return fail('invalid_input', 'nothing to export', { reason: 'nothing_to_export' });
    }

    const name = fileName(calendarName);
    const target =
      destination ??
      (await dialog.saveFile({
        defaultPath: name,
        filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      }));
    if (!target) return fail('cancelled', 'export cancelled');

    const result = await exporter.write({
      format: 'calendar',
      destination: target,
      suggestedName: name,
      files: [
        {
          path: name,
          contents: new Blob([built.ics], { type: 'text/calendar;charset=utf-8' }),
        },
      ],
    });
    if (!result.ok) return fail('storage_failed', result.error ?? 'export failed');
    return ok({ path: result.path, exported: built.exported });
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function exportCalendarCommand(
  scope: CalendarExportScope,
  destination?: string,
): Promise<CommandResult<{ path?: string; exported: number; withoutDueDate: number }>> {
  try {
    const [tasks, courses] = await Promise.all([
      library.listTasks({ scope: 'live' }),
      library.listCourses(),
    ]);
    const chosen = calendarExportTasks(tasks, scope);
    if (!chosen.tasks.length) return fail('invalid_input', 'nothing to export');

    const courseNames = new Map(courses.map((course) => [course.id, course.name]));
    const parentTitles = new Map(tasks.map((task) => [task.id, task.title]));
    const calendarName =
      scope.courseId !== undefined
        ? (courseNames.get(scope.courseId) ?? 'NotaBene')
        : 'NotaBene';
    const built = tasksToIcs(chosen.tasks, {
      courseNames,
      parentTitles,
      calendarName,
      appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
    });

    const name = fileName(calendarName);
    const target =
      destination ??
      (await dialog.saveFile({
        defaultPath: name,
        filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      }));
    if (!target) return fail('cancelled', 'export cancelled');

    const result = await exporter.write({
      format: 'calendar',
      destination: target,
      suggestedName: name,
      files: [
        {
          path: name,
          contents: new Blob([built.ics], { type: 'text/calendar;charset=utf-8' }),
        },
      ],
    });
    if (!result.ok) return fail('storage_failed', result.error ?? 'export failed');
    return ok({
      path: result.path,
      exported: built.exported,
      withoutDueDate: chosen.withoutDueDate + built.withoutDueDate,
    });
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}

/** Pick an `.ics`, read it, and plan it against the tasks already here.
 * Writes nothing. `null` when the student cancelled the panel. */
export async function readCalendarCommand(): Promise<
  CommandResult<{ name: string; plan: CalendarPlan; timetable: TimetablePlan } | null>
> {
  let path: string | undefined;
  try {
    [path] = await dialog.openFile({
      multiple: false,
      filters: [{ name: 'iCalendar', extensions: ['ics', 'ical', 'ifb'] }],
    });
  } catch (error) {
    return fail('not_supported', String(error));
  }
  if (!path) return ok(null);
  try {
    const blob = await dialog.readFile(path);
    const text = await blob.text();
    const [existing, courses] = await Promise.all([
      library.listTasks({ scope: 'all' }),
      library.listCourses(),
    ]);
    // One read, two readings: deadlines become tasks, sessions a timetable.
    const parsed = parseIcs(text);
    const plan = planCalendarImport(parsed, existing);
    const timetable = planTimetableImport(parsed, courses);
    return ok({ name: path.split(/[\\/]/).pop() ?? path, plan, timetable });
  } catch (error) {
    if (error instanceof IcsRefusal) return fail('invalid_input', error.code);
    return fail('invalid_input', 'unreadable', String(error));
  }
}

export interface CalendarImportSummary {
  created: number;
  updated: number;
  unchanged: number;
}

/**
 * Write the planned tasks the student kept, refreshing the task views once.
 *
 * An update touches only what the calendar owns — title, details, date,
 * reminder, repetition. The course, tags, status and linked notes are the
 * student's, and a newer copy of the calendar must not undo them.
 */
export async function applyCalendarImportCommand(
  planned: readonly PlannedCalendarTask[],
  options: { courseId: string | null },
): Promise<CommandResult<CalendarImportSummary>> {
  const summary: CalendarImportSummary = { created: 0, updated: 0, unchanged: 0 };
  const now = new Date().toISOString();
  try {
    for (const task of planned) {
      if (task.status === 'unchanged') {
        summary.unchanged += 1;
        continue;
      }
      const existing = task.existingId ? await library.getTask(task.existingId) : null;
      if (existing) {
        await library.upsertTask({
          ...existing,
          title: task.title,
          details: task.details,
          dueAt: task.dueAt,
          remindAt: task.remindAt,
          // A moved reminder is a new one; a stale delivery stamp would
          // silence it.
          remindedAt: task.remindAt !== existing.remindAt ? null : existing.remindedAt,
          // Only a top-level task repeats.
          recurrence: existing.parentId ? null : task.recurrence,
          importKey: existing.importKey ?? task.importKey,
          updatedAt: now,
        });
        summary.updated += 1;
        continue;
      }
      await library.upsertTask(
        createTask({
          title: task.title,
          details: task.details,
          courseId: options.courseId,
          dueAt: task.dueAt,
          remindAt: task.remindAt,
          recurrence: task.recurrence,
          status: task.event.completed ? 'done' : 'todo',
          completedAt: task.event.completed ? now : null,
          importKey: task.importKey,
        }),
      );
      summary.created += 1;
    }
  } catch (error) {
    await useLibraryStore
      .getState()
      .refreshTasks()
      .catch(() => {});
    return fail('storage_failed', String(error), summary);
  }
  await useLibraryStore
    .getState()
    .refreshTasks()
    .catch(() => {});
  return ok(summary);
}

export interface TimetableImportSummary {
  added: number;
  updated: number;
  removed: number;
  coursesCreated: number;
}

/**
 * Write the sessions the student mapped to a course (plan §4 item 1).
 *
 * New courses are created first, named after their category; every touched
 * course is then written once with its whole timetable, through the same
 * validation as the course editor. Lecture notes are never touched: removing a
 * cancelled session leaves a note already taken for it where it is.
 */
export async function applyTimetableImportCommand(
  plan: TimetablePlan,
  choices: ReadonlyMap<string, GroupChoice>,
): Promise<CommandResult<TimetableImportSummary>> {
  try {
    let courses = await library.listCourses();
    let coursesCreated = 0;
    const created = new Map<string, string>();
    for (const group of plan.groups) {
      const choice = choices.get(group.key);
      if (choice?.kind !== 'new') continue;
      if (!group.sessions.some((session) => !session.existing)) continue;
      const result = await createCourseCommand({
        name: choice.name.trim().slice(0, 200),
      });
      if (!result.ok) return result;
      created.set(`new:${group.key}`, result.value.id);
      coursesCreated += 1;
    }
    if (coursesCreated) courses = await library.listCourses();

    const { meetings, added, updated, removed } = applyTimetableChoices(
      plan,
      courses,
      choices,
    );
    const now = new Date().toISOString();
    for (const [key, list] of meetings) {
      const courseId = created.get(key) ?? key;
      const course = courses.find((entry) => entry.id === courseId);
      if (!course) continue;
      const before = JSON.stringify(course.meetings);
      if (key.startsWith('new:')) {
        list.unshift(...course.meetings);
      } else if (JSON.stringify(list) === before) {
        continue;
      }
      const parsed = CourseSchema.safeParse({
        ...course,
        meetings: list.map(normalizeMeeting),
        updatedAt: now,
      });
      if (!parsed.success) {
        return fail('invalid_input', 'invalid timetable', parsed.error.issues);
      }
      await library.upsertCourse(parsed.data);
    }
    await useLibraryStore.getState().refreshCourses();
    return ok({ added, updated, removed, coursesCreated });
  } catch (error) {
    await useLibraryStore
      .getState()
      .refreshCourses()
      .catch(() => {});
    return fail('storage_failed', String(error));
  }
}
