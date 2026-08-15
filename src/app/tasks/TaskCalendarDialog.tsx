/**
 * Every task, on a month.
 *
 * The list answers "what is next"; a calendar answers "what does this fortnight
 * look like", which is the question you ask before agreeing to something. They
 * are the same data and deliberately not the same view.
 *
 * Only tasks with a due date appear. A calendar that invented a position for
 * undated work would be making something up, so the count of what it is not
 * showing sits in the footer instead.
 */
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import type { Task } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import {
  addMonths,
  isSameDay,
  monthGrid,
  startOfDay,
  weekdayLabels,
} from '@/lib/utils/calendar';
import { cn } from '@/lib/utils/cn';

/** How many chips fit in a cell before the rest become "+3". */
const MAX_CHIPS = 3;

export function TaskCalendarDialog() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const open = useUiStore((state) => state.taskCalendarOpen);
  const setOpen = useUiStore((state) => state.setTaskCalendarOpen);
  const openTasksView = useUiStore((state) => state.openTasksView);
  const tasks = useLibraryStore((state) => state.tasks);

  const [month, setMonth] = useState(() => startOfDay(new Date()));

  const dated = useMemo(
    () => tasks.filter((task) => !task.trashedAt && task.dueAt),
    [tasks],
  );
  const undatedCount = useMemo(
    () => tasks.filter((task) => !task.trashedAt && !task.dueAt && task.status !== 'done')
      .length,
    [tasks],
  );

  /** One pass over the tasks, keyed by day, rather than a filter per cell. */
  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of dated) {
      const key = startOfDay(new Date(task.dueAt as string)).toDateString();
      const bucket = map.get(key);
      if (bucket) bucket.push(task);
      else map.set(key, [task]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
    }
    return map;
  }, [dated]);

  const today = startOfDay(new Date());
  const grid = monthGrid(month, locale);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('tasks.calendarTitle')}
      size="lg"
      headerAction={
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('tasks.previousMonth')}
            onClick={() => setMonth((current) => addMonths(current, -1))}
            className="flex size-7 items-center justify-center rounded-nb-xs text-nb-text-2 hover:bg-[var(--nb-hover)]"
          >
            <ChevronLeft size={15} aria-hidden />
          </button>
          <span className="min-w-[9ch] text-center text-[13px] font-medium">
            {month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
          </span>
          <button
            type="button"
            aria-label={t('tasks.nextMonth')}
            onClick={() => setMonth((current) => addMonths(current, 1))}
            className="flex size-7 items-center justify-center rounded-nb-xs text-nb-text-2 hover:bg-[var(--nb-hover)]"
          >
            <ChevronRight size={15} aria-hidden />
          </button>
          <GlassButton size="sm" variant="ghost" onClick={() => setMonth(startOfDay(new Date()))}>
            {t('tasks.today')}
          </GlassButton>
        </div>
      }
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-nb-text-3">
            {undatedCount > 0
              ? t('tasks.calendarUndated', { count: undatedCount })
              : t('tasks.calendarAllDated')}
          </span>
          <GlassButton variant="ghost" onClick={() => setOpen(false)}>
            {t('common.close')}
          </GlassButton>
        </>
      }
    >
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-nb-sm bg-[var(--nb-divider)]">
        {weekdayLabels(locale).map((day) => (
          <span
            key={day}
            className="bg-[var(--nb-inset-surface)] py-1 text-center text-[10.5px] font-semibold uppercase tracking-wide text-nb-text-3"
          >
            {day}
          </span>
        ))}

        {grid.flat().map((day) => {
          const outside = day.getMonth() !== month.getMonth();
          const isToday = isSameDay(day, today);
          const entries = byDay.get(day.toDateString()) ?? [];
          const overflow = entries.length - MAX_CHIPS;

          return (
            <div
              key={day.toISOString()}
              className={cn(
                'min-h-[84px] bg-[var(--nb-surface)] p-1',
                outside && 'opacity-55',
              )}
            >
              <span
                className={cn(
                  'mb-0.5 flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums',
                  isToday
                    ? 'bg-[var(--nb-accent)] font-medium text-[var(--nb-text-on-accent)]'
                    : 'text-nb-text-3',
                )}
              >
                {day.getDate()}
              </span>

              {entries.slice(0, MAX_CHIPS).map((task) => {
                const done = task.status === 'done';
                const late = !done && new Date(task.dueAt as string) < new Date();
                return (
                  <button
                    key={task.id}
                    type="button"
                    title={task.title}
                    onClick={() => {
                      openTasksView({ taskId: task.id });
                      setOpen(false);
                    }}
                    className={cn(
                      'mb-0.5 block w-full truncate rounded-[4px] px-1 py-[1px] text-left text-[11px]',
                      'transition-colors duration-[var(--nb-t-fast)] hover:brightness-95',
                      done
                        ? 'bg-[var(--nb-inset-surface)] text-nb-text-3 line-through'
                        : late
                          ? 'bg-[var(--nb-warn)] text-white'
                          : 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]',
                    )}
                  >
                    {task.title}
                  </button>
                );
              })}

              {overflow > 0 && (
                <span className="block px-1 text-[10.5px] text-nb-text-3">
                  {t('tasks.calendarMore', { count: overflow })}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

/** The button that opens it, for the Tasks list header. */
export function TaskCalendarButton() {
  const { t } = useTranslation();
  const setOpen = useUiStore((state) => state.setTaskCalendarOpen);
  return (
    <button
      type="button"
      aria-label={t('tasks.calendarTitle')}
      title={t('tasks.calendarTitle')}
      onClick={() => setOpen(true)}
      className="flex size-7 shrink-0 items-center justify-center rounded-nb-xs text-nb-text-2 hover:bg-[var(--nb-hover)] hover:text-nb-text"
    >
      <CalendarDays size={14} aria-hidden />
    </button>
  );
}
