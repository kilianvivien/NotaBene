/**
 * The task half of Trash.
 *
 * A separate list rather than `TaskList` in another mode: nothing here is part
 * of the workload, so the affordances that make a task list useful — ticking
 * one off, adding a subtask, grouping by deadline — are all wrong. What is left
 * is "what did I throw away, and can I have it back", which is one row shape
 * and one action.
 *
 * Subtasks nest under their parent, because trashing cascades: a parent and its
 * children arrive together and reading them as five unrelated rows loses why.
 */
import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ContextMenu,
  GlassIconButton,
  GlassScrollArea,
  type ContextPoint,
} from '@/components/glass';
import { restoreTasksCommand } from '@/lib/commands';
import type { Task } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { TrashTabs } from '@/app/shell/TrashTabs';

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function TrashedTaskList() {
  const { t, i18n } = useTranslation();
  const trashedTasks = useLibraryStore((state) => state.trashedTasks);
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);
  const selectTask = useUiStore((state) => state.selectTask);
  const [menu, setMenu] = useState<{ point: ContextPoint; task: Task } | null>(null);

  /** Most recently binned first: the row you want back is almost always the
   * one you just lost. */
  const rows = useMemo(() => {
    const byTrashedAt = [...trashedTasks].sort((a, b) =>
      (b.trashedAt ?? '').localeCompare(a.trashedAt ?? ''),
    );
    const trashedIds = new Set(byTrashedAt.map((task) => task.id));
    const childrenOf = new Map<string, Task[]>();
    for (const task of byTrashedAt) {
      if (!task.parentId || !trashedIds.has(task.parentId)) continue;
      const bucket = childrenOf.get(task.parentId);
      if (bucket) bucket.push(task);
      else childrenOf.set(task.parentId, [task]);
    }
    // A subtask whose parent is still live stands on its own — it was trashed
    // by itself, and hiding it under a parent that is not here would lose it.
    return byTrashedAt
      .filter((task) => !task.parentId || !trashedIds.has(task.parentId))
      .map((task) => ({ task, children: childrenOf.get(task.id) ?? [] }));
  }, [trashedTasks]);

  async function restore(taskId: string): Promise<void> {
    if (selectedTaskId === taskId) selectTask(null);
    await restoreTasksCommand([taskId]);
  }

  function renderRow(task: Task, depth: 0 | 1) {
    const selected = task.id === selectedTaskId;
    return (
      <div
        key={task.id}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ point: { x: event.clientX, y: event.clientY }, task });
        }}
        className={cn(
          'group flex w-full items-center gap-2 rounded-nb-xs px-2 py-1.5',
          'transition-colors duration-[var(--nb-t-fast)]',
          depth === 1 && 'ml-5 w-[calc(100%-1.25rem)]',
          selected
            ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
            : 'hover:bg-[var(--nb-hover)]',
        )}
      >
        <button
          type="button"
          onClick={() => selectTask(task.id)}
          aria-current={selected}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[13px] leading-snug">{task.title}</span>
          <span className="mt-0.5 block text-[11.5px] text-nb-text-3">
            {t('trash.trashedOn', { date: formatDate(task.trashedAt, i18n.language) })}
          </span>
        </button>
        {/* Always rendered, only revealed on hover or focus: a control that
            appears on hover but is absent from the tree is a control keyboard
            users do not have. */}
        <GlassIconButton
          label={t('tasks.restore')}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => void restore(task.id)}
        >
          <RotateCcw size={13} />
        </GlassIconButton>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-[var(--nb-divider)] bg-[var(--nb-list-surface)]">
      <div className="shrink-0 px-2 py-1.5">
        <TrashTabs />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--nb-divider)] px-3">
        <span className="min-w-0 shrink truncate text-[12px] text-nb-text-3">
          {t('tasks.count', { count: trashedTasks.length })}
        </span>
      </div>

      <GlassScrollArea className="flex-1 px-2 pb-3 pt-1">
        {rows.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-[13px] text-nb-text-3">{t('trash.noTasks')}</p>
            <p className="mt-1 text-[11.5px] text-nb-text-3">{t('trash.noTasksHint')}</p>
          </div>
        ) : (
          rows.map(({ task, children }) => (
            <div key={task.id}>
              {renderRow(task, 0)}
              {children.map((child) => renderRow(child, 1))}
            </div>
          ))
        )}
      </GlassScrollArea>

      {menu && (
        <ContextMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          header={menu.task.title}
          items={[
            {
              id: 'restore',
              label: t('tasks.restore'),
              icon: RotateCcw,
              onSelect: () => void restore(menu.task.id),
            },
          ]}
        />
      )}
    </div>
  );
}
