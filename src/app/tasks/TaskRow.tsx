/**
 * One line of the task list.
 *
 * The row is a button that opens the task; the checkbox inside it stops the
 * click from propagating, so ticking something off never navigates away from
 * the list you are working through.
 */
import { CalendarClock, Bell, Repeat, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassCheckbox } from '@/components/glass';
import type { Task, TaskStatus } from '@/lib/schema';
import { cn } from '@/lib/utils/cn';
import { formatTaskDate, keySuffix } from './taskLabels';

export function TaskRow({
  task,
  selected,
  overdue,
  progress,
  linkedNoteCount,
  depth = 0,
  onOpen,
  onStatusChange,
  onContextMenu,
}: {
  task: Task;
  selected: boolean;
  overdue: boolean;
  progress?: { done: number; total: number };
  linkedNoteCount: number;
  depth?: 0 | 1;
  onOpen(): void;
  onStatusChange(next: TaskStatus): void;
  onContextMenu(event: React.MouseEvent): void;
}) {
  const { t, i18n } = useTranslation();
  const done = task.status === 'done';

  // The checkbox is a *sibling* of the row button, not a child of it. Nesting
  // one button inside another is invalid HTML: the browser drops the inner one
  // out of the accessibility tree, and React warns about it on every render.
  return (
    <div
      onContextMenu={onContextMenu}
      className={cn(
        'group flex w-full items-start gap-2 rounded-nb-xs px-2 py-1.5',
        'transition-colors duration-[var(--nb-t-fast)]',
        depth === 1 && 'ml-5 w-[calc(100%-1.25rem)]',
        selected
          ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
          : 'hover:bg-[var(--nb-hover)]',
      )}
    >
      <span className="mt-[1px]">
        <GlassCheckbox
          status={task.status}
          onChange={onStatusChange}
          label={task.title}
          size={depth === 1 ? 'sm' : 'md'}
        />
      </span>

      <button
        type="button"
        onClick={onOpen}
        aria-current={selected}
        className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            'block truncate text-[13px] leading-snug',
            done ? 'text-nb-text-3 line-through' : selected ? undefined : 'text-nb-text',
            task.priority === 'high' && !done && 'font-medium',
          )}
        >
          {task.title}
        </span>

        {(task.dueAt || task.recurrence || progress?.total || linkedNoteCount > 0) && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-nb-text-3">
            {task.dueAt && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  overdue && !done && 'text-[var(--nb-warn)]',
                )}
              >
                <CalendarClock size={11} aria-hidden />
                {formatTaskDate(task.dueAt, i18n.language)}
              </span>
            )}
            {task.remindAt && !done && (
              <span className="flex items-center gap-1">
                <Bell size={11} aria-hidden />
                {formatTaskDate(task.remindAt, i18n.language)}
              </span>
            )}
            {task.recurrence && (
              <span className="flex items-center gap-1">
                <Repeat size={11} aria-hidden />
                {t(`tasks.recurrence${keySuffix(task.recurrence.freq)}`)}
              </span>
            )}
            {progress && progress.total > 0 && (
              <span>
                {t('tasks.subtaskProgress', {
                  done: progress.done,
                  total: progress.total,
                })}
              </span>
            )}
            {linkedNoteCount > 0 && (
              <span className="flex items-center gap-1">
                <FileText size={11} aria-hidden />
                {linkedNoteCount}
              </span>
            )}
          </span>
        )}
      </button>

      {task.priority !== 'none' && !done && (
        <span
          aria-label={t(`tasks.priority${keySuffix(task.priority)}`)}
          className={cn(
            'mt-[6px] size-[6px] shrink-0 rounded-full',
            task.priority === 'high' && 'bg-[var(--nb-danger)]',
            task.priority === 'medium' && 'bg-[var(--nb-warn)]',
            task.priority === 'low' && 'bg-[var(--nb-text-3)]',
          )}
        />
      )}
    </div>
  );
}
