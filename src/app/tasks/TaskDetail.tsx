/**
 * The centre column when the Tasks view is open.
 *
 * It is the task as a page — what it is called, what it is about, and the
 * checklist under it. Everything *about* it — status, priority, course,
 * deadline, reminder, recurrence, the notes it is attached to — lives in the
 * inspector beside it, the same division the note editor uses. What is settled
 * there is summarised here as a strip of chips under the title, so the pane
 * still answers "when is this due" at a glance and clicking through opens the
 * field that decides it.
 *
 * Edits commit as they are made rather than behind a Save button: the list
 * beside it is live, and a due date that has visibly changed but not actually
 * been written is the kind of thing that loses a deadline. Text fields commit
 * on blur; everything else commits on change.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  CornerLeftUp,
  FileSearch,
  GraduationCap,
  ListTodo,
  ListTree,
  Loader2,
  Plus,
  Quote,
  Repeat,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  FieldSection,
  GlassButton,
  GlassCheckbox,
  GlassIconButton,
  GlassScrollArea,
} from '@/components/glass';
import {
  checkTaskAgainstNotesCommand,
  completeTaskCommand,
  createTaskCommand,
  trashTasksCommand,
  updateTaskCommand,
} from '@/lib/commands';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import type { TaskCheckResult } from '@/lib/ai';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { dialog } from '@/lib/adapters';
import type { Task, TaskStatus } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { TaskRow } from './TaskRow';
import { groupFor, subtaskProgress } from './taskGrouping';
import { formatTaskDate, keySuffix } from './taskLabels';

export function TaskDetail() {
  const { t, i18n } = useTranslation();
  const view = useUiStore((state) => state.view);
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);
  const selectTask = useUiStore((state) => state.selectTask);
  const setInspectorTab = useUiStore((state) => state.setInspectorTab);
  const openTaskDialog = useUiStore((state) => state.openTaskDialog);
  const openTaskBreakdown = useUiStore((state) => state.openTaskBreakdown);
  const tasks = useLibraryStore((state) => state.tasks);
  const courses = useLibraryStore((state) => state.courses);
  const links = useLibraryStore((state) => state.taskNoteLinks);
  const checking = useAiStore((state) => state.running) === 'taskCheck';
  const planAvailable = useAiAvailability('tasks').available;

  const task = tasks.find((entry) => entry.id === selectedTaskId) ?? null;

  // Local mirrors for the two free-text fields, so typing is not fighting a
  // round trip through the store on every keystroke.
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [subtaskTitle, setSubtaskTitle] = useState('');
  /** The last verdict, kept in the pane rather than in the library: it is an
   * opinion about the notes as they are right now, and storing it would make a
   * stale one look like a fact about the task. */
  const [verdict, setVerdict] = useState<TaskCheckResult | null>(null);
  const [checkError, setCheckError] = useState('');
  /** Set on the way into Trash, so the blur that follows does not file a
   * subtask under a parent on its way out — it would survive the cascade and
   * then be invisible in every list. */
  const discardSubtask = useRef(false);

  useEffect(() => {
    setTitle(task?.title ?? '');
    setDetails(task?.details ?? '');
  }, [task?.id, task?.title, task?.details]);

  useEffect(() => {
    setSubtaskTitle('');
    setVerdict(null);
    setCheckError('');
  }, [task?.id]);

  if (!task) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <ListTodo size={26} className="text-nb-text-3" aria-hidden />
        <p className="text-[13px] text-nb-text-3">{t('tasks.noSelection')}</p>
        <GlassButton
          size="sm"
          onClick={() =>
            openTaskDialog({
              courseId: view.kind === 'tasks' ? view.courseId : undefined,
            })
          }
        >
          <Plus size={13} aria-hidden />
          {t('tasks.new')}
        </GlassButton>
      </div>
    );
  }

  const parent = task.parentId
    ? (tasks.find((entry) => entry.id === task.parentId) ?? null)
    : null;
  const children = tasks.filter(
    (entry) => entry.parentId === task.id && !entry.trashedAt,
  );
  const progress = subtaskProgress(tasks, task.id);
  const course = courses.find((entry) => entry.id === task.courseId) ?? null;
  const linkedNoteCount = links.filter((link) => link.taskId === task.id).length;
  const done = task.status === 'done';
  const overdue = groupFor(task) === 'overdue' && !done;

  // `const` rather than `function`: a hoisted declaration is not covered by the
  // null guard above, and TypeScript is right to say so.
  const patch = (input: Partial<Parameters<typeof updateTaskCommand>[0]>): void => {
    void updateTaskCommand({ taskId: task.id, ...input });
  };

  /** Everything the chips stand for is decided in the inspector, and
   * `setInspectorTab` reveals it, so one click is the whole journey. */
  const openFields = (): void => setInspectorTab('info');

  const addSubtask = async (): Promise<void> => {
    const trimmed = subtaskTitle.trim();
    if (!trimmed) return;
    const result = await createTaskCommand({
      title: trimmed,
      parentId: task.id,
      // A subtask that belongs to a different course than its parent is a
      // filing mistake, not a feature.
      courseId: task.courseId,
    });
    // Cleared only on success, so a refused write leaves the words on screen.
    if (result.ok) setSubtaskTitle('');
  };

  /** The bin sits a click away from the title and takes the subtasks with it,
   * so it asks first — and says how many go with it, which is the part that is
   * not visible from the button. */
  const trash = async (): Promise<void> => {
    const confirmed = await dialog.confirm(
      children.length
        ? t('tasks.trashConfirmSubtasks', {
            title: task.title,
            count: children.length,
          })
        : t('tasks.trashConfirm', { title: task.title }),
      { title: t('tasks.trash'), danger: true },
    );
    if (!confirmed) return;
    const result = await trashTasksCommand([task.id]);
    if (result.ok) selectTask(null);
  };

  const check = async (): Promise<void> => {
    setCheckError('');
    setVerdict(null);
    const signal = beginRun('taskCheck');
    const outcome = await checkTaskAgainstNotesCommand(task.id, { signal });
    endRun('taskCheck', signal);
    if (outcome.ok) {
      setVerdict(outcome.value);
      return;
    }
    // A cancel is not a failure — the student pressed Stop and knows why.
    if (outcome.code === 'cancelled') return;
    setCheckError(
      outcome.code === 'not_supported' ? t('ai.notConfiguredHint') : outcome.message,
    );
  };

  const statusChange = (entry: Task, next: TaskStatus): void => {
    if (next === 'done' || entry.status === 'done') {
      void completeTaskCommand({ taskId: entry.id, done: next === 'done' });
    } else {
      void updateTaskCommand({ taskId: entry.id, status: next });
    }
  };

  return (
    <GlassScrollArea className="flex-1 px-6 py-5" resetKey={task.id}>
      <div className="mx-auto max-w-[560px]">
        {parent && (
          <button
            type="button"
            onClick={() => selectTask(parent.id)}
            className="mb-2 flex max-w-full items-center gap-1.5 rounded-nb-xs py-0.5 text-[11.5px] text-nb-text-3 hover:text-nb-text-2"
          >
            <CornerLeftUp size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{t('tasks.partOf', { title: parent.title })}</span>
          </button>
        )}

        <div className="flex items-start gap-3">
          {/* The tick replaced a full-width accent button that was the loudest
              thing on the page. Ticking a task off is the gesture the list
              already uses, so the pane uses it too. */}
          <span className="mt-[7px]">
            <GlassCheckbox
              status={task.status}
              onChange={(next) => statusChange(task, next)}
              label={done ? t('tasks.reopen') : t('tasks.complete')}
            />
          </span>
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
              'min-w-0 flex-1 bg-transparent text-[22px] font-semibold leading-tight text-nb-text',
              'focus-visible:outline-none',
              done && 'text-nb-text-3 line-through',
            )}
          />
          {/* Ghost, not danger: the loud red read as the second thing to do on
              the page. It asks first — it sits a click from the title, and it
              takes the subtasks with it. */}
          <GlassIconButton
            label={t('tasks.trash')}
            className="mt-0.5 shrink-0"
            onMouseDown={() => {
              discardSubtask.current = true;
            }}
            onClick={() => void trash()}
          >
            <Trash2 size={14} />
          </GlassIconButton>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <MetaChip
            icon={CalendarClock}
            tone={overdue ? 'warn' : task.dueAt ? 'set' : 'unset'}
            onClick={openFields}
          >
            {task.dueAt ? formatTaskDate(task.dueAt, i18n.language) : t('tasks.noDate')}
          </MetaChip>
          {task.remindAt && !done && (
            <MetaChip icon={Bell} tone="set" onClick={openFields}>
              {formatTaskDate(task.remindAt, i18n.language)}
            </MetaChip>
          )}
          {task.recurrence && (
            <MetaChip icon={Repeat} tone="set" onClick={openFields}>
              {t(`tasks.recurrence${keySuffix(task.recurrence.freq)}`)}
            </MetaChip>
          )}
          {task.priority !== 'none' && (
            <MetaChip
              dot={
                task.priority === 'high'
                  ? 'var(--nb-danger)'
                  : task.priority === 'medium'
                    ? 'var(--nb-warn)'
                    : 'var(--nb-text-3)'
              }
              tone="set"
              onClick={openFields}
            >
              {t(`tasks.priority${keySuffix(task.priority)}`)}
            </MetaChip>
          )}
          <MetaChip
            icon={GraduationCap}
            tone={course ? 'set' : 'unset'}
            onClick={openFields}
          >
            {course ? course.name : t('tasks.noCourse')}
          </MetaChip>
        </div>

        {/* Disabled rather than hidden when nothing is linked: "check my notes"
            is only discoverable if it is on screen to be read, and the reason
            it cannot run is the thing worth saying. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <GlassButton
            size="sm"
            variant="ghost"
            disabled={!linkedNoteCount || !planAvailable || checking}
            title={
              !linkedNoteCount
                ? t('tasks.checkNeedsNotes')
                : planAvailable
                  ? undefined
                  : t('ai.notConfiguredHint')
            }
            onClick={() => void check()}
          >
            {checking ? (
              <Loader2 size={13} className="animate-spin" aria-hidden />
            ) : (
              <FileSearch size={13} aria-hidden />
            )}
            {checking ? t('ai.running') : t('tasks.checkAgainstNotes')}
          </GlassButton>
          {checking && (
            <button
              type="button"
              onClick={() => cancelRun('taskCheck')}
              className="rounded-nb-xs px-2 py-1 text-[11.5px] text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
            >
              {t('ai.cancel')}
            </button>
          )}
        </div>

        {(verdict || checkError) && (
          <TaskCheckCard
            verdict={verdict}
            error={checkError}
            onDismiss={() => {
              setVerdict(null);
              setCheckError('');
            }}
            onComplete={() => {
              void completeTaskCommand({ taskId: task.id, done: true });
              setVerdict(null);
            }}
          />
        )}

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

        {!task.parentId && (
          <div className="mt-5 pb-6">
            <FieldSection title={t('tasks.subtasks')}>
              {progress.total > 0 && (
                <div className="-mt-1 mb-1.5 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--nb-active)]"
                  >
                    <span
                      className="block h-full rounded-full bg-[var(--nb-accent)] transition-[width] duration-[var(--nb-t-fast)]"
                      style={{ width: `${(progress.done / progress.total) * 100}%` }}
                    />
                  </span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-nb-text-3">
                    {t('tasks.subtaskProgress', {
                      done: progress.done,
                      total: progress.total,
                    })}
                  </span>
                </div>
              )}
              {children.map((child) => (
                <TaskRow
                  key={child.id}
                  task={child}
                  selected={false}
                  overdue={groupFor(child) === 'overdue'}
                  linkedNoteCount={0}
                  onOpen={() => selectTask(child.id)}
                  onStatusChange={(next) => statusChange(child, next)}
                  onContextMenu={(event) => event.preventDefault()}
                />
              ))}
              {/* Typed in place rather than in the dialog: a subtask is a line,
                  and a modal for one line is what stops people writing them
                  down. The dialog is still where a subtask with a deadline of
                  its own comes from. */}
              <div className="mt-1 flex items-center gap-2 rounded-nb-xs px-2 py-1">
                <Plus size={13} aria-hidden className="shrink-0 text-nb-text-3" />
                <input
                  value={subtaskTitle}
                  onChange={(event) => setSubtaskTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void addSubtask();
                    }
                    if (event.key === 'Escape') setSubtaskTitle('');
                  }}
                  onBlur={() => {
                    if (discardSubtask.current) {
                      discardSubtask.current = false;
                      setSubtaskTitle('');
                      return;
                    }
                    void addSubtask();
                  }}
                  placeholder={t('tasks.newSubtask')}
                  aria-label={t('tasks.newSubtask')}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-nb-text placeholder:text-nb-text-3 focus-visible:outline-none"
                />
              </div>
              {/* Under the list, not above it: the student's own steps come
                  first, and the model is an offer rather than the way in. */}
              <GlassButton
                size="sm"
                variant="ghost"
                className="mt-1"
                disabled={!planAvailable}
                title={planAvailable ? undefined : t('ai.notConfiguredHint')}
                onClick={() => openTaskBreakdown(task.id)}
              >
                <ListTree size={13} aria-hidden />
                {t('tasks.breakDown')}
              </GlassButton>
            </FieldSection>
          </div>
        )}
      </div>
    </GlassScrollArea>
  );
}

/**
 * What the notes say, and what to do about it.
 *
 * The verdict is deliberately not a status the task carries. It is one model's
 * reading of a few notes at one moment, so it lives in the pane until dismissed
 * and the only thing it can change is offered as a button the student presses.
 * The quotes are the point: a verdict you cannot check is a verdict worth
 * nothing, and "done" with a passage from the student's own note beside it is
 * one they can settle in a second.
 */
function TaskCheckCard({
  verdict,
  error,
  onDismiss,
  onComplete,
}: {
  verdict: TaskCheckResult | null;
  error: string;
  onDismiss(): void;
  onComplete(): void;
}) {
  const { t } = useTranslation();
  const tone =
    verdict?.verdict === 'done'
      ? 'var(--nb-success)'
      : verdict?.verdict === 'notDone'
        ? 'var(--nb-warn)'
        : 'var(--nb-text-3)';

  return (
    <section className="mt-3 rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3">
      <div className="flex items-start gap-2">
        {verdict ? (
          <span className="mt-[3px] shrink-0" style={{ color: tone }} aria-hidden>
            {verdict.verdict === 'done' ? (
              <CheckCircle2 size={14} />
            ) : (
              <CircleHelp size={14} />
            )}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          {verdict ? (
            <>
              <p className="text-[12px] font-semibold" style={{ color: tone }}>
                {t(`tasks.verdict${keySuffix(verdict.verdict)}`)}
              </p>
              <p className="mt-1 text-[12.5px] leading-snug text-nb-text-2">
                {verdict.summary}
              </p>
              {verdict.evidence.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {verdict.evidence.map((entry, index) => (
                    <li
                      key={`${entry.noteTitle}-${index}`}
                      className="border-l-2 border-[var(--nb-divider)] pl-2"
                    >
                      <p className="flex items-start gap-1 text-[11.5px] leading-snug text-nb-text-3">
                        <Quote size={10} aria-hidden className="mt-[3px] shrink-0" />
                        <span>{entry.quote}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-nb-text-3">
                        {entry.noteTitle}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] leading-snug text-nb-text-3">
                {t('tasks.checkDisclaimer')}
              </p>
              {verdict.verdict === 'done' && (
                <GlassButton
                  size="sm"
                  variant="accent"
                  className="mt-2"
                  onClick={onComplete}
                >
                  <CheckCircle2 size={13} aria-hidden />
                  {t('tasks.complete')}
                </GlassButton>
              )}
            </>
          ) : (
            <p className="text-[12.5px] leading-snug text-[var(--nb-danger)]">{error}</p>
          )}
        </div>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={onDismiss}
          className="shrink-0 rounded-nb-xs p-1 text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
        >
          <X size={12} />
        </button>
      </div>
    </section>
  );
}

/**
 * One fact about the task, and the way back to the field that decides it.
 *
 * Unset facts are shown too, greyed — "no due date" is the one a student most
 * needs to notice, and a chip that is simply absent says nothing.
 */
function MetaChip({
  icon: Icon,
  dot,
  tone,
  onClick,
  children,
}: {
  icon?: LucideIcon;
  dot?: string;
  tone: 'set' | 'unset' | 'warn';
  onClick(): void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('tasks.showFields')}
      className={cn(
        'flex max-w-[14rem] items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11.5px]',
        'transition-colors duration-[var(--nb-t-fast)] hover:bg-[var(--nb-hover)]',
        tone === 'warn'
          ? 'border-[color-mix(in_srgb,var(--nb-warn)_35%,transparent)] text-[var(--nb-warn)]'
          : tone === 'set'
            ? 'border-[var(--nb-divider)] text-nb-text-2'
            : 'border-dashed border-[var(--nb-divider)] text-nb-text-3',
      )}
    >
      {Icon && <Icon size={11} aria-hidden className="shrink-0" />}
      {dot && (
        <span
          aria-hidden
          className="size-[6px] shrink-0 rounded-full"
          style={{ backgroundColor: dot }}
        />
      )}
      <span className="truncate">{children}</span>
    </button>
  );
}
