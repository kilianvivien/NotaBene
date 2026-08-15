/**
 * Choose a task to drop into a paragraph.
 *
 * A dialog rather than a `@`-suggestion popup: the suggestion plugin would be a
 * second inline-completion mechanism alongside the slash menu, and the two
 * would have to agree about focus, escape and arrow keys forever. A picker is
 * one keystroke more and no new interaction model.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import { fold } from '@/lib/search/fold';
import type { Task } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { cn } from '@/lib/utils/cn';

export function TaskPicker({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose(): void;
  onChoose(task: Task): void;
}) {
  const { t } = useTranslation();
  const tasks = useLibraryStore((state) => state.tasks);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const matches = useMemo(() => {
    const term = fold(query.trim());
    return tasks
      .filter((task) => !task.trashedAt)
      .filter((task) => !term || fold(task.title).includes(term))
      .slice(0, 30);
  }, [tasks, query]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('tasks.linkNote')}
      size="sm"
      footer={
        <GlassButton variant="ghost" onClick={onClose}>
          {t('tasks.cancel')}
        </GlassButton>
      }
    >
      <input
        data-autofocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('tasks.titlePlaceholder')}
        aria-label={t('tasks.titleLabel')}
        className="w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2.5 py-2 text-[13px] text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]"
      />

      <ul className="mt-2 max-h-[280px] overflow-y-auto">
        {matches.length === 0 ? (
          <li className="px-2 py-3 text-[12px] text-nb-text-3">{t('tasks.empty')}</li>
        ) : (
          matches.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => {
                  onChoose(task);
                  onClose();
                }}
                className="flex w-full items-center gap-2 rounded-nb-xs px-2 py-1.5 text-left text-[13px] hover:bg-[var(--nb-hover)]"
              >
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    task.status === 'done' && 'text-nb-text-3 line-through',
                  )}
                >
                  {task.title}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </Dialog>
  );
}
