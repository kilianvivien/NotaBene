/**
 * The centre column when the Tasks view is open.
 *
 * Edits here are committed as they are made rather than behind a Save button:
 * the list beside it is live, and a due date that has visibly changed but not
 * actually been written is the kind of thing that loses a deadline. Text fields
 * commit on blur; everything else commits on change.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  FieldRow,
  FieldSection,
  GlassButton,
  GlassDateField,
  GlassScrollArea,
  GlassSelect,
} from '@/components/glass';
import {
  completeTaskCommand,
  linkTaskToNoteCommand,
  trashTasksCommand,
  updateTaskCommand,
} from '@/lib/commands';
import {
  RECURRENCE_FREQS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Recurrence,
  type Task,
} from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { TaskRow } from './TaskRow';
import { groupFor, subtaskProgress } from './taskGrouping';

/** Title-cases an enum member into its `tasks.*` key suffix. */
function keySuffix(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function TaskDetail() {
  const { t } = useTranslation();
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);
  const selectTask = useUiStore((state) => state.selectTask);
  const selectNote = useUiStore((state) => state.selectNote);
  const setView = useUiStore((state) => state.setView);
  const openTaskDialog = useUiStore((state) => state.openTaskDialog);
  const tasks = useLibraryStore((state) => state.tasks);
  const links = useLibraryStore((state) => state.taskNoteLinks);
  const notes = useLibraryStore((state) => state.notes);
  const courses = useLibraryStore((state) => state.courses);

  const task = tasks.find((entry) => entry.id === selectedTaskId) ?? null;

  // Local mirrors for the two free-text fields, so typing is not fighting a
  // round trip through the store on every keystroke.
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');

  useEffect(() => {
    setTitle(task?.title ?? '');
    setDetails(task?.details ?? '');
  }, [task?.id, task?.title, task?.details]);

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-[13px] text-nb-text-3">{t('tasks.noSelection')}</p>
      </div>
    );
  }

  const children = tasks.filter(
    (entry) => entry.parentId === task.id && !entry.trashedAt,
  );
  const progress = subtaskProgress(tasks, task.id);
  const linkedNoteIds = links
    .filter((link) => link.taskId === task.id)
    .map((link) => link.noteId);
  const done = task.status === 'done';

  // `const` rather than `function`: a hoisted declaration is not covered by the
  // null guard above, and TypeScript is right to say so.
  const patch = (input: Partial<Parameters<typeof updateTaskCommand>[0]>): void => {
    void updateTaskCommand({ taskId: task.id, ...input });
  };

  const setRecurrence = (freq: string): void => {
    if (freq === 'none') {
      patch({ recurrence: null });
      return;
    }
    const next: Recurrence = {
      freq: freq as Recurrence['freq'],
      interval: task.recurrence?.interval ?? 1,
      weekdays: task.recurrence?.weekdays ?? [],
    };
    patch({ recurrence: next });
  };

  return (
    <GlassScrollArea className="flex-1 px-6 py-5" resetKey={task.id}>
      <div className="mx-auto max-w-[640px]">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const trimmed = title.trim();
            // An emptied title is a slip, not an instruction: the schema
            // refuses it, so put the stored one back rather than showing a
            // field that silently will not save.
            if (!trimmed) setTitle(task.title);
            else if (trimmed !== task.title) patch({ title: trimmed });
          }}
          aria-label={t('tasks.titleLabel')}
          className={cn(
            'w-full bg-transparent text-[22px] font-semibold leading-tight text-nb-text',
            'focus-visible:outline-none',
            done && 'text-nb-text-3 line-through',
          )}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <GlassButton
            variant={done ? 'default' : 'accent'}
            size="sm"
            onClick={() => void completeTaskCommand({ taskId: task.id, done: !done })}
          >
            {done ? (
              <RotateCcw size={13} aria-hidden />
            ) : (
              <CheckCircle2 size={13} aria-hidden />
            )}
            {done ? t('tasks.reopen') : t('tasks.complete')}
          </GlassButton>
          <GlassButton
            variant="danger"
            size="sm"
            onClick={() => {
              void trashTasksCommand([task.id]);
              selectTask(null);
            }}
          >
            <Trash2 size={13} aria-hidden />
            {t('tasks.trash')}
          </GlassButton>
        </div>

        <div className="mt-5">
          <FieldSection title={t('tasks.details')}>
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              onBlur={() => {
                if (details !== task.details) patch({ details });
              }}
              rows={4}
              placeholder={t('tasks.detailsPlaceholder')}
              aria-label={t('tasks.details')}
              className="w-full resize-y rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2.5 py-2 text-[13px] leading-relaxed text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]"
            />
          </FieldSection>
        </div>

        <div className="mt-5">
          <FieldSection title={t('tasks.status')}>
            <FieldRow label={t('tasks.status')}>
              <GlassSelect
                label={t('tasks.status')}
                value={task.status}
                onChange={(event) => {
                  const next = event.target.value as Task['status'];
                  if (next === 'done' || done) {
                    void completeTaskCommand({ taskId: task.id, done: next === 'done' });
                  } else patch({ status: next });
                }}
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`tasks.status${keySuffix(status)}`)}
                  </option>
                ))}
              </GlassSelect>
            </FieldRow>

            <FieldRow label={t('tasks.priority')}>
              <GlassSelect
                label={t('tasks.priority')}
                value={task.priority}
                onChange={(event) =>
                  patch({ priority: event.target.value as Task['priority'] })
                }
              >
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {t(`tasks.priority${keySuffix(priority)}`)}
                  </option>
                ))}
              </GlassSelect>
            </FieldRow>

            <FieldRow label={t('tasks.course')}>
              <GlassSelect
                label={t('tasks.course')}
                value={task.courseId ?? ''}
                onChange={(event) => patch({ courseId: event.target.value || null })}
              >
                <option value="">{t('tasks.noCourse')}</option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </GlassSelect>
            </FieldRow>
          </FieldSection>
        </div>

        <div className="mt-5">
          <FieldSection title={t('tasks.dueDate')}>
            <FieldRow label={t('tasks.dueDate')}>
              <GlassDateField
                label={t('tasks.dueDate')}
                value={task.dueAt}
                onChange={(next) => patch({ dueAt: next })}
              />
            </FieldRow>
            <FieldRow label={t('tasks.remindAt')}>
              <GlassDateField
                label={t('tasks.remindAt')}
                value={task.remindAt}
                onChange={(next) => patch({ remindAt: next })}
                showQuickChips={false}
              />
            </FieldRow>
            <FieldRow
              label={t('tasks.recurrence')}
              hint={task.parentId ? t('tasks.recurrenceSubtaskHint') : undefined}
            >
              <GlassSelect
                label={t('tasks.recurrence')}
                value={task.recurrence?.freq ?? 'none'}
                disabled={task.parentId !== null}
                onChange={(event) => setRecurrence(event.target.value)}
              >
                <option value="none">{t('tasks.recurrenceNone')}</option>
                {RECURRENCE_FREQS.map((freq) => (
                  <option key={freq} value={freq}>
                    {t(`tasks.recurrence${keySuffix(freq)}`)}
                  </option>
                ))}
              </GlassSelect>
            </FieldRow>
          </FieldSection>
        </div>

        {!task.parentId && (
          <div className="mt-5">
            <FieldSection
              title={`${t('tasks.subtasks')}${
                progress.total
                  ? ` — ${t('tasks.subtaskProgress', {
                      done: progress.done,
                      total: progress.total,
                    })}`
                  : ''
              }`}
            >
              {children.map((child) => (
                <TaskRow
                  key={child.id}
                  task={child}
                  selected={false}
                  overdue={groupFor(child) === 'overdue'}
                  linkedNoteCount={0}
                  onOpen={() => selectTask(child.id)}
                  onStatusChange={(next) =>
                    next === 'done' || child.status === 'done'
                      ? void completeTaskCommand({
                          taskId: child.id,
                          done: next === 'done',
                        })
                      : void updateTaskCommand({ taskId: child.id, status: next })
                  }
                  onContextMenu={(event) => event.preventDefault()}
                />
              ))}
              <GlassButton
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() =>
                  openTaskDialog({
                    parentId: task.id,
                    courseId: task.courseId ?? undefined,
                  })
                }
              >
                <Plus size={13} aria-hidden />
                {t('tasks.newSubtask')}
              </GlassButton>
            </FieldSection>
          </div>
        )}

        <div className="mt-5 pb-6">
          <FieldSection title={t('tasks.linkedNotes')}>
            {linkedNoteIds.length === 0 ? (
              <p className="text-[12px] text-nb-text-3">{t('tasks.noLinkedNotes')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {linkedNoteIds.map((noteId) => {
                  const note = notes.find((entry) => entry.id === noteId);
                  return (
                    <li key={noteId} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          // Opening a linked note means leaving the Tasks view;
                          // there is no note editor inside it.
                          setView({ kind: 'all' });
                          selectNote(noteId);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-nb-xs px-2 py-1 text-left text-[12.5px] text-nb-text-2 hover:bg-[var(--nb-hover)]"
                      >
                        <FileText size={12} aria-hidden className="shrink-0" />
                        <span className="truncate">
                          {note?.title || t('noteList.untitled')}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void linkTaskToNoteCommand({
                            taskId: task.id,
                            noteId,
                            linked: false,
                          })
                        }
                        className="rounded-nb-xs px-2 py-1 text-[11.5px] text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
                      >
                        {t('tasks.unlink')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </FieldSection>
        </div>
      </div>
    </GlassScrollArea>
  );
}
