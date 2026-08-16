/**
 * The inspector while the Tasks view is open.
 *
 * It used to keep showing the note the editor happened to have open last — a
 * pane about a note, standing beside a list of tasks, which is why it read as
 * broken rather than as a leftover. The inspector now follows the view, and the
 * split is the one the rest of the app already uses: the centre column is what
 * the thing *is* — its title, what it is about, the checklist under it — and
 * this column is everything *about* it, exactly as a note's course, dates and
 * tags live here rather than in the page.
 *
 * The controls are stacked, label above field, because 280px has no room for
 * the two-column `FieldRow` the dialogs use.
 */
import { useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FieldSection, GlassDateField, GlassSelect } from '@/components/glass';
import {
  completeTaskCommand,
  linkTaskToNoteCommand,
  updateTaskCommand,
} from '@/lib/commands';
import {
  RECURRENCE_FREQS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Recurrence,
  type Task,
  type TaskStatus,
} from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { ensureReminderPermission } from '@/lib/tasks/reminderScheduler';
import { keySuffix } from './taskLabels';

export function TaskInspector() {
  const { t } = useTranslation();
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);
  const tasks = useLibraryStore((state) => state.tasks);
  const task = tasks.find((entry) => entry.id === selectedTaskId) ?? null;

  // The same sentence the centre column shows, rather than the note pane's
  // "select a note": two panes disagreeing about what is missing is what made
  // the empty inspector confusing in the first place.
  if (!task) {
    return <p className="text-[12px] text-nb-text-3">{t('tasks.noSelection')}</p>;
  }
  return <TaskFields key={task.id} task={task} />;
}

/** Label above control, the way `InfoPanel` lays out a note's course. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-2.5 first:mt-0">
      {/* A `div`, not a `label`: `GlassDateField`'s trigger is a button, and a
          button inside a label gets clicked twice by the label's own
          forwarding. Every control here already carries its own accessible
          name through its `label` prop. */}
      <span className="block text-[12px] text-nb-text-3">{label}</span>
      <div className="mt-1 [&>*]:w-full">{children}</div>
      {hint && <p className="mt-1 text-[11px] leading-snug text-nb-text-3">{hint}</p>}
    </div>
  );
}

function TaskFields({ task }: { task: Task }) {
  const { t, i18n } = useTranslation();
  const courses = useLibraryStore((state) => state.courses);
  const notes = useLibraryStore((state) => state.notes);
  const links = useLibraryStore((state) => state.taskNoteLinks);
  const setView = useUiStore((state) => state.setView);
  const selectNote = useUiStore((state) => state.selectNote);
  /** Set only when macOS has actually refused, so the row stays quiet normally. */
  const [reminderHint, setReminderHint] = useState<string | null>(null);

  const linked = links.filter((link) => link.taskId === task.id);

  const patch = (input: Partial<Parameters<typeof updateTaskCommand>[0]>): void => {
    void updateTaskCommand({ taskId: task.id, ...input });
  };

  /** Reaching `done` — or leaving it — is a completion, not a field write: it
   * is what rolls a recurrence forward and cascades to subtasks. */
  const setStatus = (next: TaskStatus): void => {
    if (next === 'done' || task.status === 'done') {
      void completeTaskCommand({ taskId: task.id, done: next === 'done' });
    } else {
      patch({ status: next });
    }
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
    <div className="flex flex-col gap-4">
      <FieldSection title={t('tasks.sectionProgress')}>
        <Field label={t('tasks.status')}>
          <GlassSelect
            label={t('tasks.status')}
            size="sm"
            value={task.status}
            onChange={(event) => setStatus(event.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`tasks.status${keySuffix(status)}`)}
              </option>
            ))}
          </GlassSelect>
        </Field>

        <Field label={t('tasks.priority')}>
          <GlassSelect
            label={t('tasks.priority')}
            size="sm"
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
        </Field>

        <Field label={t('tasks.course')}>
          <GlassSelect
            label={t('tasks.course')}
            size="sm"
            value={task.courseId ?? ''}
            onChange={(event) => patch({ courseId: event.target.value || null })}
          >
            <option value="">{t('tasks.noCourse')}</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.icon} {course.name}
              </option>
            ))}
          </GlassSelect>
        </Field>
      </FieldSection>

      <FieldSection title={t('tasks.sectionSchedule')}>
        <Field label={t('tasks.dueDate')}>
          <GlassDateField
            label={t('tasks.dueDate')}
            value={task.dueAt}
            onChange={(next) => patch({ dueAt: next })}
          />
        </Field>

        <Field label={t('tasks.remindAt')} hint={reminderHint ?? undefined}>
          <GlassDateField
            label={t('tasks.remindAt')}
            value={task.remindAt}
            onChange={(next) => {
              patch({ remindAt: next });
              // Setting a reminder is the first moment the student has
              // expressed any interest in being notified, and therefore the
              // right moment to ask macOS — not at launch, where a prompt out
              // of nowhere gets refused for good.
              if (next) {
                void ensureReminderPermission().then((allowed) =>
                  setReminderHint(allowed ? null : t('tasks.reminderPermissionDenied')),
                );
              }
            }}
            showQuickChips={false}
          />
        </Field>

        <Field
          label={t('tasks.recurrence')}
          hint={task.parentId ? t('tasks.recurrenceSubtaskHint') : undefined}
        >
          <GlassSelect
            label={t('tasks.recurrence')}
            size="sm"
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
        </Field>
      </FieldSection>

      <FieldSection title={t('tasks.linkedNotes')}>
        {linked.length === 0 ? (
          <p className="text-[12px] text-nb-text-3">{t('tasks.noLinkedNotes')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {linked.map((link) => {
              const note = notes.find((entry) => entry.id === link.noteId);
              return (
                <li key={link.noteId} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      // Opening a linked note means leaving the Tasks view;
                      // there is no note editor inside it.
                      setView({ kind: 'all' });
                      selectNote(link.noteId);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-nb-xs px-1.5 py-1 text-left text-[12px] text-nb-text-2 hover:bg-[var(--nb-hover)]"
                  >
                    <FileText size={12} aria-hidden className="shrink-0" />
                    <span className="truncate">
                      {note?.title || t('noteList.untitled')}
                    </span>
                  </button>
                  {/* A `mention` row is rebuilt from the note's document on
                      every save, so unlinking one here would appear to work
                      and be back a keystroke later. Say where it comes from
                      instead — the chip in the note is what removes it. */}
                  {link.origin === 'mention' ? (
                    <span
                      title={t('tasks.mentionedIn')}
                      className="shrink-0 px-1 text-[11px] text-nb-text-3"
                    >
                      {t('tasks.mentionShort')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void linkTaskToNoteCommand({
                          taskId: task.id,
                          noteId: link.noteId,
                          linked: false,
                        })
                      }
                      className="shrink-0 rounded-nb-xs px-1.5 py-1 text-[11.5px] text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
                    >
                      {t('tasks.unlink')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </FieldSection>

      <div className="nb-details-panel">
        <dl>
          <div>
            <dt>{t('inspector.created')}</dt>
            <dd>{new Date(task.createdAt).toLocaleString(i18n.language)}</dd>
          </div>
          <div>
            <dt>{t('inspector.modified')}</dt>
            <dd>{new Date(task.updatedAt).toLocaleString(i18n.language)}</dd>
          </div>
          {task.completedAt && (
            <div>
              <dt>{t('tasks.completedAtLabel')}</dt>
              <dd>{new Date(task.completedAt).toLocaleString(i18n.language)}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
