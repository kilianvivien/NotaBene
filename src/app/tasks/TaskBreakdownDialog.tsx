/**
 * "What does this actually involve?"
 *
 * Generate, untick what is wrong, add the rest. Nothing is written until Add,
 * and what lands is ordinary subtasks — editable, tickable, and indistinguish-
 * able from typed ones a minute later, which is the point: the model drafts the
 * list, the student owns it.
 *
 * Titles are not editable here on purpose. A row that is nearly right is one
 * click from being added and then edited in the pane where every other task is
 * edited; a second editing surface inside a dialog would be a worse copy of it.
 */
import { useEffect, useState } from 'react';
import { CalendarClock, ListTree, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AiDialogStatus } from '@/app/ai/AiDisclosure';
import { useAiAvailability } from '@/app/ai/useAiAvailability';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import { MAX_AI_SOURCES, type SubtaskDraft } from '@/lib/ai';
import { createSubtasksCommand, proposeSubtasksCommand } from '@/lib/commands';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { formatTaskDate } from './taskLabels';

export function TaskBreakdownDialog() {
  const { t, i18n } = useTranslation();
  const taskId = useUiStore((state) => state.taskBreakdownFor);
  const close = useUiStore((state) => state.closeTaskBreakdown);
  const tasks = useLibraryStore((state) => state.tasks);
  const running = useAiStore((state) => state.running) === 'taskPlan';
  const availability = useAiAvailability('tasks');

  const task = tasks.find((entry) => entry.id === taskId) ?? null;
  const linkedCount = useLibraryStore(
    (state) => state.taskNoteLinks.filter((link) => link.taskId === taskId).length,
  );

  const [drafts, setDrafts] = useState<SubtaskDraft[]>([]);
  /** Indices the student has kept. Everything arrives kept. */
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  /** True once a run has come back, so "nothing to add" can be said out loud
   * rather than looking like a button that did nothing. */
  const [generated, setGenerated] = useState(false);

  // A plan for last week's essay is not a plan for this one.
  useEffect(() => {
    setDrafts([]);
    setChosen(new Set());
    setError('');
    setGenerated(false);
  }, [taskId]);

  async function generate(): Promise<void> {
    if (!taskId) return;
    setError('');
    const signal = beginRun('taskPlan');
    const outcome = await proposeSubtasksCommand(taskId, { signal });
    endRun('taskPlan', signal);

    if (!outcome.ok) {
      // A cancel is not a failure: the student pressed the button.
      if (outcome.code === 'cancelled') return;
      // The source limit comes back as `details.limit` so the sentence is
      // translated here rather than carried out of the command in English.
      const limit =
        outcome.details && typeof outcome.details === 'object'
          ? (outcome.details as { limit?: string }).limit
          : undefined;
      setError(
        outcome.code === 'not_supported'
          ? t('ai.notConfiguredHint')
          : limit === 'too_many_notes'
            ? t('ai.limit_too_many_notes', { max: MAX_AI_SOURCES })
            : limit === 'over_budget'
              ? t('ai.limit_over_budget')
              : outcome.message,
      );
      return;
    }
    setDrafts(outcome.value);
    setChosen(new Set(outcome.value.map((_, index) => index)));
    setGenerated(true);
  }

  async function add(): Promise<void> {
    if (!taskId) return;
    const kept = drafts.filter((_, index) => chosen.has(index));
    if (!kept.length) return;
    setSaving(true);
    const outcome = await createSubtasksCommand(taskId, kept);
    setSaving(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    close();
  }

  function toggle(index: number): void {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function dismiss(): void {
    cancelRun('taskPlan');
    close();
  }

  return (
    <Dialog
      open={taskId !== null}
      onClose={dismiss}
      title={t('tasks.breakDown')}
      description={task ? t('tasks.breakDownIntro', { title: task.title }) : undefined}
      size="md"
      headerAction={<AiDialogStatus feature="tasks" onLeave={dismiss} />}
      footer={
        <>
          {running ? (
            <GlassButton size="sm" onClick={() => cancelRun('taskPlan')}>
              {t('ai.cancel')}
            </GlassButton>
          ) : (
            <GlassButton size="sm" onClick={dismiss}>
              {t('common.cancel')}
            </GlassButton>
          )}
          <GlassButton
            size="sm"
            variant={drafts.length ? 'ghost' : 'accent'}
            disabled={!availability.available || running}
            onClick={() => void generate()}
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              drafts.length > 0 && <RefreshCw size={12} />
            )}
            {running
              ? t('ai.running')
              : drafts.length
                ? t('ai.regenerate')
                : t('ai.generate')}
          </GlassButton>
          {drafts.length > 0 && (
            <GlassButton
              size="sm"
              variant="accent"
              disabled={chosen.size === 0 || saving}
              onClick={() => void add()}
            >
              {t('tasks.addSubtasks', { count: chosen.size })}
            </GlassButton>
          )}
        </>
      }
    >
      {drafts.length ? (
        <ul className="flex flex-col gap-1">
          {drafts.map((draft, index) => (
            <li key={`${draft.title}-${index}`}>
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-nb-sm px-2 py-1.5',
                  'hover:bg-[var(--nb-hover)]',
                  !chosen.has(index) && 'opacity-55',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-[3px] accent-[var(--nb-accent)]"
                  checked={chosen.has(index)}
                  onChange={() => toggle(index)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug text-nb-text">
                    {draft.title}
                  </span>
                  {draft.details && (
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-nb-text-3">
                      {draft.details}
                    </span>
                  )}
                  {draft.dueAt && (
                    <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-nb-text-3">
                      <CalendarClock size={11} aria-hidden />
                      {formatTaskDate(draft.dueAt, i18n.language)}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-nb-sm border border-dashed border-[var(--nb-divider)] px-6 text-center text-nb-text-3">
          <ListTree size={24} aria-hidden />
          <p className="max-w-[46ch] text-[12px] leading-snug">
            {generated
              ? t('tasks.breakDownNothingToAdd')
              : linkedCount > 0
                ? t('tasks.breakDownEmpty', { count: linkedCount })
                : t('tasks.breakDownEmptyNoNotes')}
          </p>
        </div>
      )}

      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}
