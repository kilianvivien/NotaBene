/**
 * The task list column — what the note list is for notes.
 *
 * Grouped by deadline rather than sorted flat, because "what is late" and "what
 * is today" are the two questions a student opens this view to answer. Subtasks
 * render nested under their parent instead of as rows of their own.
 */
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ContextMenu,
  GlassIconButton,
  GlassScrollArea,
  GlassSegmentedControl,
  GlassSelect,
  type ContextPoint,
} from '@/components/glass';
import type { TaskQuery } from '@/lib/adapters';
import { completeTaskCommand, trashTasksCommand, updateTaskCommand } from '@/lib/commands';
import type { Task, TaskStatus } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { TaskCalendarButton } from './TaskCalendarDialog';
import { TaskRow } from './TaskRow';
import { groupFor, groupTasks, subtaskProgress, TASK_GROUP_LABELS } from './taskGrouping';

type StatusFilter = 'open' | 'done' | 'all';
type TaskSort = NonNullable<TaskQuery['sort']>;

export function TaskList() {
  const { t } = useTranslation();
  const view = useUiStore((state) => state.view);
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);
  const selectTask = useUiStore((state) => state.selectTask);
  const openTaskDialog = useUiStore((state) => state.openTaskDialog);
  const tasks = useLibraryStore((state) => state.tasks);
  const links = useLibraryStore((state) => state.taskNoteLinks);

  const [filter, setFilter] = useState<StatusFilter>('open');
  const [sort, setSort] = useState<TaskSort>('due');
  const [menu, setMenu] = useState<{ point: ContextPoint; task: Task } | null>(null);

  const courseId = view.kind === 'tasks' ? view.courseId : undefined;

  const visible = useMemo(() => {
    const now = new Date();
    const scoped = tasks.filter((task) => {
      if (task.trashedAt) return false;
      if (courseId && task.courseId !== courseId) return false;
      if (filter === 'open' && task.status === 'done') return false;
      if (filter === 'done' && task.status !== 'done') return false;
      return true;
    });
    if (sort === 'due') return groupTasks(scoped, now);
    // Any other sort is an explicit request for one flat ordering, so the
    // deadline bands would only get in the way. `listTasks` already returned
    // them ordered; keep that and present them as a single group.
    return [{ id: 'later' as const, tasks: scoped.filter((task) => !task.parentId) }];
  }, [tasks, courseId, filter, sort]);

  const childrenOf = useMemo(() => {
    const byParent = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.parentId || task.trashedAt) continue;
      const bucket = byParent.get(task.parentId);
      if (bucket) bucket.push(task);
      else byParent.set(task.parentId, [task]);
    }
    return byParent;
  }, [tasks]);

  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of links) {
      counts.set(link.taskId, (counts.get(link.taskId) ?? 0) + 1);
    }
    return counts;
  }, [links]);

  const total = visible.reduce((sum, group) => sum + group.tasks.length, 0);
  const now = new Date();

  function statusChange(task: Task, next: TaskStatus): void {
    // Cycling through the checkbox to `done` must take the recurrence and
    // subtask-cascade path, which a plain status write does not.
    if (next === 'done' || task.status === 'done') {
      void completeTaskCommand({ taskId: task.id, done: next === 'done' });
    } else {
      void updateTaskCommand({ taskId: task.id, status: next });
    }
  }

  function renderRow(task: Task, depth: 0 | 1) {
    return (
      <TaskRow
        key={task.id}
        task={task}
        depth={depth}
        selected={task.id === selectedTaskId}
        overdue={groupFor(task, now) === 'overdue'}
        progress={depth === 0 ? subtaskProgress(tasks, task.id) : undefined}
        linkedNoteCount={linkCounts.get(task.id) ?? 0}
        onOpen={() => selectTask(task.id)}
        onStatusChange={(next) => statusChange(task, next)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ point: { x: event.clientX, y: event.clientY }, task });
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-[var(--nb-divider)] bg-[var(--nb-list-surface)]">
      <header className="flex items-center gap-1 px-2 py-1.5">
        <GlassSegmentedControl<StatusFilter>
          label={t('tasks.status')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: t('tasks.filterOpen') },
            { value: 'done', label: t('tasks.filterDone') },
            { value: 'all', label: t('tasks.filterAll') },
          ]}
          fill
        />
        <TaskCalendarButton />
        <GlassIconButton
          label={t('tasks.new')}
          className="size-7 shrink-0"
          onClick={() => openTaskDialog({ courseId })}
        >
          <Plus size={14} />
        </GlassIconButton>
      </header>

      <div className="flex items-center justify-between gap-2 px-3 pb-1.5">
        <span className="truncate text-[11.5px] text-nb-text-3">
          {t('tasks.count', { count: total })}
        </span>
        <GlassSelect
          label={t('tasks.sortLabel')}
          variant="plain"
          size="sm"
          value={sort}
          onChange={(event) => setSort(event.target.value as TaskSort)}
        >
          <option value="due">{t('tasks.sort.due')}</option>
          <option value="priority">{t('tasks.sort.priority')}</option>
          <option value="created">{t('tasks.sort.created')}</option>
          <option value="updated">{t('tasks.sort.updated')}</option>
        </GlassSelect>
      </div>

      <GlassScrollArea className="flex-1 px-2 pb-3">
        {total === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-[13px] text-nb-text-3">{t('tasks.empty')}</p>
            <p className="mt-1 text-[11.5px] text-nb-text-3">{t('tasks.emptyHint')}</p>
          </div>
        ) : (
          visible.map((group) => (
            <section key={group.id} className="mb-2">
              {sort === 'due' && (
                <h2 className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
                  {t(TASK_GROUP_LABELS[group.id])}
                </h2>
              )}
              {group.tasks.map((task) => (
                <div key={task.id}>
                  {renderRow(task, 0)}
                  {(childrenOf.get(task.id) ?? [])
                    .filter((child) => filter !== 'open' || child.status !== 'done')
                    .map((child) => renderRow(child, 1))}
                </div>
              ))}
            </section>
          ))
        )}
      </GlassScrollArea>

      {menu && (
        <ContextMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          items={[
            {
              id: 'complete',
              label:
                menu.task.status === 'done' ? t('tasks.reopen') : t('tasks.complete'),
              onSelect: () =>
                void completeTaskCommand({
                  taskId: menu.task.id,
                  done: menu.task.status !== 'done',
                }),
            },
            {
              id: 'subtask',
              label: t('tasks.newSubtask'),
              // Depth is one level, so a subtask cannot have one of its own.
              disabled: menu.task.parentId !== null,
              onSelect: () =>
                useUiStore.getState().openTaskDialog({
                  parentId: menu.task.id,
                  courseId: menu.task.courseId ?? undefined,
                }),
            },
            null,
            {
              id: 'trash',
              label: t('tasks.trash'),
              danger: true,
              onSelect: () => {
                void trashTasksCommand([menu.task.id]);
                if (selectedTaskId === menu.task.id) selectTask(null);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
