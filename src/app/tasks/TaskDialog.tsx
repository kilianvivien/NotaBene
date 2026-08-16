/**
 * Quick task creation.
 *
 * Deliberately only creation: editing happens in the detail pane, live. A
 * dialog that also edited would be a second place the same fields live, and the
 * two would drift.
 *
 * The draft it opens with carries where it was opened *from* — a course row, a
 * parent task, the note on screen — so "new task for this note" is one step.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  FieldNote,
  FieldRow,
  GlassButton,
  GlassDateField,
  GlassSelect,
} from '@/components/glass';
import { createTaskCommand } from '@/lib/commands';
import { TASK_PRIORITIES, type Task } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

export function TaskDialog() {
  const { t } = useTranslation();
  const draft = useUiStore((state) => state.taskDraft);
  const closeTaskDialog = useUiStore((state) => state.closeTaskDialog);
  const selectTask = useUiStore((state) => state.selectTask);
  const courses = useLibraryStore((state) => state.courses);

  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState('');
  const [priority, setPriority] = useState<Task['priority']>('none');
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reseed whenever the dialog opens, so yesterday's half-typed title is not
  // still sitting there.
  useEffect(() => {
    if (!draft) return;
    setTitle('');
    setCourseId(draft.courseId ?? '');
    setPriority('none');
    setDueAt(null);
    setError(null);
  }, [draft]);

  async function submit(): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    const result = await createTaskCommand({
      title: trimmed,
      courseId: courseId || null,
      priority,
      dueAt,
      parentId: draft?.parentId ?? null,
      noteIds: draft?.noteIds,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    selectTask(result.value.id);
    closeTaskDialog();
  }

  return (
    <Dialog
      open={draft !== null}
      onClose={closeTaskDialog}
      title={draft?.parentId ? t('tasks.newSubtask') : t('tasks.new')}
      size="sm"
      footer={
        <>
          <GlassButton variant="ghost" onClick={closeTaskDialog}>
            {t('tasks.cancel')}
          </GlassButton>
          <GlassButton
            variant="accent"
            disabled={!title.trim() || saving}
            onClick={() => void submit()}
          >
            {t('tasks.create')}
          </GlassButton>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <input
          data-autofocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits: this dialog is one field plus three defaults, and
            // reaching for the mouse to add a to-do is the friction it exists
            // to remove.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t('tasks.titlePlaceholder')}
          aria-label={t('tasks.titleLabel')}
          className="w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2.5 py-2 text-[14px] text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]"
        />

        <FieldRow label={t('tasks.dueDate')}>
          <GlassDateField label={t('tasks.dueDate')} value={dueAt} onChange={setDueAt} />
        </FieldRow>

        {!draft?.parentId && (
          <FieldRow label={t('tasks.course')}>
            <GlassSelect
              label={t('tasks.course')}
              value={courseId}
              onChange={(event) => setCourseId(event.target.value)}
            >
              <option value="">{t('tasks.noCourse')}</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </GlassSelect>
          </FieldRow>
        )}

        <FieldRow label={t('tasks.priority')}>
          <GlassSelect
            label={t('tasks.priority')}
            value={priority}
            onChange={(event) => setPriority(event.target.value as Task['priority'])}
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {t(`tasks.priority${value.charAt(0).toUpperCase()}${value.slice(1)}`)}
              </option>
            ))}
          </GlassSelect>
        </FieldRow>

        {error && <FieldNote tone="danger">{error}</FieldNote>}
      </div>
    </Dialog>
  );
}
