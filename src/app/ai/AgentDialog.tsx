import {
  AlertCircle,
  Check,
  FileClock,
  Loader2,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton, GlassSelect } from '@/components/glass';
import { DEFAULT_AGENT_BUDGET } from '@/lib/ai';
import { planAgentCommand, runAgentCommand, undoAgentRunCommand } from '@/lib/commands';
import type { AgentRunRecord, AgentScope } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { AiDialogStatus } from './AiDisclosure';
import { useAiAvailability } from './useAiAvailability';

/**
 * The in-app agent is deliberately a staged sheet, not a chat box. The plan,
 * scope and ceilings are visible before the first tool can run; after that the
 * same surface becomes an audit log and a door into the exact before-version.
 */
export function AgentDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.agentOpen);
  const setOpen = useUiStore((state) => state.setAgentOpen);
  const note = useEditorStore((state) => state.note);
  const selection = useUiStore((state) => state.multiSelection);
  const view = useUiStore((state) => state.view);
  const courses = useLibraryStore((state) => state.courses);
  const activeRunId = useAgentStore((state) => state.activeRunId);
  const run = useAgentStore((state) =>
    state.runs.find((entry) => entry.id === state.activeRunId),
  );
  const running = useAiStore((state) => state.running) === 'agent';
  const availability = useAiAvailability('agent');
  const [instruction, setInstruction] = useState('');
  const [scope, setScope] = useState<AgentScope>({ kind: 'library' });
  const [planning, setPlanning] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState('');

  const selectionIds = useMemo(
    () => (selection.length ? selection : note ? [note.id] : []),
    [selection, note],
  );
  const courseId = view.kind === 'course' ? view.courseId : (note?.courseId ?? undefined);

  useEffect(() => {
    if (!open || activeRunId) return;
    if (selection.length) {
      setScope({ kind: 'selection', noteIds: selection });
    } else if (courseId) {
      setScope({ kind: 'course', courseId });
    } else if (note) {
      setScope({ kind: 'selection', noteIds: [note.id] });
    } else {
      setScope({ kind: 'library' });
    }
  }, [open, activeRunId, selection, courseId, note]);

  function close() {
    if (running || planning) cancelRun('agent');
    setOpen(false);
  }

  function newTask() {
    cancelRun('agent');
    useAgentStore.getState().setActiveRun(null);
    setInstruction('');
    setError('');
  }

  async function plan() {
    setPlanning(true);
    setError('');
    const signal = beginRun('agent');
    const response = await planAgentCommand(
      { instruction, scope, budget: DEFAULT_AGENT_BUDGET },
      { signal },
    );
    endRun('agent', signal);
    setPlanning(false);
    if (!response.ok && response.code !== 'cancelled') {
      setError(
        response.code === 'not_supported' ? t('ai.notConfiguredHint') : response.message,
      );
    }
  }

  async function execute() {
    if (!run) return;
    setError('');
    const signal = beginRun('agent');
    const response = await runAgentCommand(run.id, { signal });
    endRun('agent', signal);
    if (!response.ok && response.code !== 'cancelled') setError(response.message);
  }

  async function undo() {
    if (!run) return;
    setUndoing(true);
    setError('');
    const response = await undoAgentRunCommand(run.id);
    setUndoing(false);
    if (!response.ok) setError(response.message);
  }

  async function openTouchedNote(touched: AgentRunRecord['touchedNotes'][number]) {
    setOpen(false);
    useUiStore.getState().requestVersionSnapshot(touched.snapshotId);
    useUiStore.getState().selectNote(touched.noteId);
    await useEditorStore.getState().openNote(touched.noteId);
    useUiStore.getState().setInspectorTab(touched.snapshotId ? 'versions' : 'info');
  }

  const canUndo = Boolean(
    run &&
    run.status !== 'planned' &&
    run.status !== 'running' &&
    run.status !== 'undone' &&
    (run.touchedNotes.length ||
      run.undoJournal.createdCourses.length ||
      run.undoJournal.createdSections.length ||
      run.undoJournal.createdTagIds.length ||
      run.undoJournal.tagsBeforeRename.length),
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('agent.title')}
      description={t('agent.intro')}
      size="lg"
      headerAction={<AiDialogStatus feature="agent" onLeave={close} />}
      footer={
        run ? (
          <>
            <GlassButton size="sm" variant="ghost" onClick={newTask} disabled={running}>
              {t('agent.newTask')}
            </GlassButton>
            <span className="mr-auto" />
            {canUndo && (
              <GlassButton size="sm" onClick={() => void undo()} disabled={undoing}>
                {undoing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                {t('agent.undoRun')}
              </GlassButton>
            )}
            <GlassButton size="sm" onClick={running ? () => cancelRun('agent') : close}>
              {running ? t('agent.stop') : t('common.close')}
            </GlassButton>
            {run.status === 'planned' && (
              <GlassButton
                size="sm"
                variant="accent"
                disabled={!availability.available || running}
                onClick={() => void execute()}
              >
                {running ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Sparkles size={12} />
                )}
                {running ? t('agent.running') : t('agent.runPlan')}
              </GlassButton>
            )}
          </>
        ) : (
          <>
            <GlassButton size="sm" onClick={planning ? () => cancelRun('agent') : close}>
              {planning ? t('agent.stop') : t('common.cancel')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="accent"
              disabled={!instruction.trim() || !availability.available || planning}
              onClick={() => void plan()}
            >
              {planning && <Loader2 size={12} className="animate-spin" />}
              {planning ? t('agent.planning') : t('agent.makePlan')}
            </GlassButton>
          </>
        )
      }
    >
      {run ? (
        <RunReview run={run} running={running} onOpenNote={openTouchedNote} />
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-nb-text-2">
            {t('agent.instruction')}
            <textarea
              data-autofocus
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={t('agent.instructionPlaceholder')}
              rows={5}
              className="resize-none rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-3 py-2 text-[13px] font-normal leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-[12px] font-medium text-nb-text-2">
            {t('agent.scope')}
            <GlassSelect
              label={t('agent.scope')}
              size="sm"
              value={scopeValue(scope)}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'selection' && selectionIds.length) {
                  setScope({ kind: 'selection', noteIds: selectionIds });
                } else if (value.startsWith('course:')) {
                  setScope({ kind: 'course', courseId: value.slice(7) });
                } else {
                  setScope({ kind: 'library' });
                }
              }}
            >
              {selectionIds.length > 0 && (
                <option value="selection">
                  {t('agent.scopeSelection', { count: selectionIds.length })}
                </option>
              )}
              {courseId && (
                <option value={`course:${courseId}`}>
                  {t('agent.scopeCourse', {
                    name:
                      courses.find((course) => course.id === courseId)?.name ?? courseId,
                  })}
                </option>
              )}
              <option value="library">{t('agent.scopeLibrary')}</option>
            </GlassSelect>
          </label>
          <p className="rounded-nb-sm bg-[var(--nb-inset-surface)] px-3 py-2 text-[11px] leading-relaxed text-nb-text-3">
            {t('agent.planGate')}
          </p>
          {error && <ErrorMessage message={error} />}
        </div>
      )}
    </Dialog>
  );
}

function RunReview({
  run,
  running,
  onOpenNote,
}: {
  run: AgentRunRecord;
  running: boolean;
  onOpenNote(touched: AgentRunRecord['touchedNotes'][number]): void;
}) {
  const { t } = useTranslation();
  const seconds = Math.round(run.budget.wallClockMs / 1_000);
  return (
    <div className="flex flex-col gap-4">
      <section>
        <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
          {t('agent.plan')}
        </p>
        <h3 className="mt-1 text-[14px] font-semibold">{run.plan.summary}</h3>
        <ol className="mt-2 space-y-1.5">
          {run.plan.steps.map((step, index) => (
            <li
              key={index}
              className="flex gap-2 text-[12px] leading-relaxed text-nb-text-2"
            >
              <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[var(--nb-hover)] text-[10px] text-nb-text-3">
                {index + 1}
              </span>
              <span>
                {step.description}
                {step.expectedTools.length > 0 && (
                  <span className="ml-1 text-[10px] text-nb-text-3">
                    {step.expectedTools.join(' · ')}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid grid-cols-4 gap-2 rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3 text-center">
        <Budget label={t('agent.scope')} value={scopeLabel(run.scope, t)} />
        <Budget
          label={t('agent.tokenCeiling')}
          value={run.budget.tokenCeiling.toLocaleString()}
        />
        <Budget
          label={t('agent.toolCeiling')}
          value={String(run.budget.toolCallCeiling)}
        />
        <Budget
          label={t('agent.timeCeiling')}
          value={t('agent.seconds', { count: seconds })}
        />
      </section>

      {run.status !== 'planned' && (
        <section>
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
              {t('agent.activity')}
            </p>
            <StatusLabel status={run.status} />
          </div>
          {run.calls.length ? (
            <ul className="mt-2 space-y-1.5">
              {run.calls.map((call) => (
                <li
                  key={call.id}
                  className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <CallIcon status={call.status} />
                    <code className="text-[11px] font-semibold text-nb-text-2">
                      {call.tool}
                    </code>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-nb-text-3">
                      {call.rationale}
                    </span>
                  </div>
                  {(call.resultPreview || call.error) && (
                    <p
                      className={`mt-1 line-clamp-2 pl-5 text-[10px] ${call.error ? 'text-[var(--nb-danger)]' : 'text-nb-text-3'}`}
                    >
                      {call.error ?? call.resultPreview}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : running ? (
            <p className="mt-2 flex items-center gap-2 text-[12px] text-nb-text-3">
              <Loader2 size={12} className="animate-spin" /> {t('agent.thinking')}
            </p>
          ) : null}
        </section>
      )}

      {(run.summary || run.error || run.touchedNotes.length > 0) && (
        <section className="rounded-nb-sm bg-[var(--nb-inset-surface)] p-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
            {t('agent.result')}
          </p>
          {run.summary && (
            <p className="mt-1 text-[12px] leading-relaxed text-nb-text-2">
              {run.summary}
            </p>
          )}
          {run.error && <ErrorMessage message={run.error} />}
          {run.touchedNotes.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {run.touchedNotes.map((touched) => (
                <li key={touched.noteId}>
                  <button
                    type="button"
                    onClick={() => onOpenNote(touched)}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--nb-hover)] px-2 py-1 text-[11px] text-nb-text-2 hover:text-[var(--nb-accent)]"
                    title={touched.snapshotId ? t('agent.openDiff') : t('agent.openNote')}
                  >
                    <FileClock size={10} />
                    {touched.title || t('editor.untitled')}
                    <span className="text-[9px] text-nb-text-3">
                      {touched.created ? t('agent.created') : t('agent.changed')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-nb-text-3">
            {t('agent.usage', {
              tokens: run.tokensUsed.toLocaleString(),
              calls: run.calls.length,
            })}
          </p>
        </section>
      )}
    </div>
  );
}

function Budget({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] text-nb-text-3">{label}</p>
      <p className="mt-0.5 truncate text-[11px] font-semibold text-nb-text-2">{value}</p>
    </div>
  );
}

function StatusLabel({ status }: { status: AgentRunRecord['status'] }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--nb-hover)] px-2 py-0.5 text-[10px] text-nb-text-3">
      {status === 'running' && <Loader2 size={9} className="animate-spin" />}
      {t(`agent.status_${status}`)}
    </span>
  );
}

function CallIcon({ status }: { status: AgentRunRecord['calls'][number]['status'] }) {
  if (status === 'running')
    return <Loader2 size={12} className="animate-spin text-[var(--nb-accent)]" />;
  if (status === 'succeeded')
    return <Check size={12} className="text-[var(--nb-success)]" />;
  if (status === 'failed') return <X size={12} className="text-[var(--nb-danger)]" />;
  return <Square size={10} className="text-nb-text-3" />;
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--nb-danger)]">
      <AlertCircle size={12} className="mt-0.5 shrink-0" /> {message}
    </p>
  );
}

function scopeValue(scope: AgentScope): string {
  return scope.kind === 'course' ? `course:${scope.courseId}` : scope.kind;
}

function scopeLabel(
  scope: AgentScope,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (scope.kind === 'selection')
    return t('agent.scopeSelection', { count: scope.noteIds.length });
  if (scope.kind === 'course') return t('agent.scopeCourseShort');
  return t('agent.scopeLibraryShort');
}
