/**
 * The tasks attached to the note on screen.
 *
 * Lives in the inspector rather than as new shell furniture, because that is
 * where every other thing-about-this-note already is — versions, backlinks,
 * attachments. It shows both kinds of link without distinguishing them: from
 * the student's side, a task they attached and a task they mentioned inline are
 * both "tasks for this note", and only the rebuild rules care which is which.
 */
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassButton } from '@/components/glass';
import { completeTaskCommand, updateTaskCommand } from '@/lib/commands';
import type { Task, TaskStatus } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { TaskRow } from './TaskRow';
import { groupFor } from './taskGrouping';

export function NoteTasksPanel({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const tasks = useLibraryStore((state) => state.tasks);
  const links = useLibraryStore((state) => state.taskNoteLinks);
  const openTasksView = useUiStore((state) => state.openTasksView);
  const openTaskDialog = useUiStore((state) => state.openTaskDialog);

  const linkedIds = new Set(
    links.filter((link) => link.noteId === noteId).map((link) => link.taskId),
  );
  const linked = tasks.filter((task) => linkedIds.has(task.id) && !task.trashedAt);

  function statusChange(task: Task, next: TaskStatus): void {
    if (next === 'done' || task.status === 'done') {
      void completeTaskCommand({ taskId: task.id, done: next === 'done' });
    } else {
      void updateTaskCommand({ taskId: task.id, status: next });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {linked.length === 0 ? (
        // "Not linked to any note" is the sentence for the other direction —
        // this panel is the note's side of the same link.
        <p className="text-[12px] text-nb-text-3">{t('tasks.noNoteTasks')}</p>
      ) : (
        linked.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={false}
            overdue={groupFor(task) === 'overdue'}
            linkedNoteCount={0}
            onOpen={() => openTasksView({ taskId: task.id })}
            onStatusChange={(next) => statusChange(task, next)}
            onContextMenu={(event) => event.preventDefault()}
          />
        ))
      )}
      <GlassButton
        variant="ghost"
        size="sm"
        className="mt-1 self-start"
        onClick={() => openTaskDialog({ noteIds: [noteId] })}
      >
        <Plus size={13} aria-hidden />
        {t('tasks.newForNote')}
      </GlassButton>
    </div>
  );
}
