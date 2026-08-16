/**
 * How the task list is divided up, and what the sidebar badge counts.
 *
 * Kept out of the components because both of them have to agree: a badge saying
 * "3 overdue" while the Overdue group holds four rows is the kind of thing that
 * makes a student stop trusting the list.
 */
import type { Task } from '@/lib/schema';

export type TaskGroupId =
  | 'overdue'
  | 'today'
  | 'week'
  | 'later'
  | 'noDate'
  | 'done';

export const TASK_GROUP_LABELS: Record<TaskGroupId, string> = {
  overdue: 'tasks.groupOverdue',
  today: 'tasks.groupToday',
  week: 'tasks.groupWeek',
  later: 'tasks.groupLater',
  noDate: 'tasks.groupNoDate',
  done: 'tasks.groupDone',
};

/** Group order, top to bottom. Done sits last: it is a record, not a workload. */
export const TASK_GROUP_ORDER: TaskGroupId[] = [
  'overdue',
  'today',
  'week',
  'later',
  'noDate',
  'done',
];

function endOfDay(reference: Date): number {
  const end = new Date(reference);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/**
 * Which band a task falls in.
 *
 * "Today" means the rest of today by wall clock, not the next 24 hours — a task
 * due at 18:00 is due today at 09:00 and still due today at 17:00, and one due
 * at 09:00 tomorrow was never due today.
 */
export function groupFor(task: Task, now: Date = new Date()): TaskGroupId {
  if (task.status === 'done') return 'done';
  if (!task.dueAt) return 'noDate';

  const due = new Date(task.dueAt).getTime();
  if (due < now.getTime()) return 'overdue';
  if (due <= endOfDay(now)) return 'today';

  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  return due <= endOfDay(weekEnd) ? 'week' : 'later';
}

export interface TaskGroup {
  id: TaskGroupId;
  tasks: Task[];
}

/**
 * Split top-level tasks into their bands, dropping empty ones.
 *
 * Subtasks are deliberately absent: the list renders them nested under their
 * parent, and a subtask due next Tuesday appearing separately under "This week"
 * would show the same work twice.
 */
export function groupTasks(tasks: Task[], now: Date = new Date()): TaskGroup[] {
  const buckets = new Map<TaskGroupId, Task[]>();
  for (const task of tasks) {
    if (task.parentId) continue;
    const id = groupFor(task, now);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(task);
    else buckets.set(id, [task]);
  }
  return TASK_GROUP_ORDER.filter((id) => buckets.get(id)?.length).map((id) => ({
    id,
    tasks: buckets.get(id) as Task[],
  }));
}

/**
 * What the sidebar badge shows: open work, and how much of it is late.
 *
 * Subtasks count here, unlike in the grouping — "4 overdue" should mean four
 * things are late, whether or not they happen to belong to a parent.
 */
export function taskCounts(
  tasks: Task[],
  now: Date = new Date(),
): { open: number; overdue: number } {
  let open = 0;
  let overdue = 0;
  for (const task of tasks) {
    if (task.trashedAt || task.status === 'done') continue;
    open += 1;
    if (task.dueAt && new Date(task.dueAt).getTime() < now.getTime()) overdue += 1;
  }
  return { open, overdue };
}

/** Progress on a parent, for the `3 of 5` a parent row shows. */
export function subtaskProgress(
  tasks: Task[],
  parentId: string,
): { done: number; total: number } {
  const children = tasks.filter((task) => task.parentId === parentId && !task.trashedAt);
  return {
    done: children.filter((task) => task.status === 'done').length,
    total: children.length,
  };
}
