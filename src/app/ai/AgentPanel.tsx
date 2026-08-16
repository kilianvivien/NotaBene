/**
 * The agent half of the inspector's AI tab.
 *
 * It replaced a 680px modal, and the move cost the run its walls: the app is
 * live while the agent works, so three things had to change rather than be
 * ported. The run now outlives its panel — closing the inspector, opening
 * another note, or switching the Agent switch off leaves it running, and only
 * Stop cancels. Progress is read from `agentStore` and `aiStore` rather than
 * from local state, so coming back mid-run shows the run and not a blank
 * composer. And the review gate had to survive a 280px column: the plan, the
 * scope and the sentence saying when the agent gives up are still on screen
 * before the button that starts it, because a gate you scroll past is not one.
 *
 * Nothing here talks in tool names or JSON — see `agentLanguage.ts` for why the
 * audit record and the sentence a student reads are not the same string.
 */
import {
  AlertCircle,
  Bot,
  Check,
  FileClock,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassPopupButton } from '@/components/glass';
import { DEFAULT_AGENT_BUDGET } from '@/lib/ai';
import type { AskScope } from '@/lib/ai';
import { planAgentCommand, runAgentCommand, undoAgentRunCommand } from '@/lib/commands';
import type { AgentRunRecord, AgentScope } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiDisclosureButton } from './AiDisclosure';
import { AiModeSwitch } from './AiModeSwitch';
import { AiStatusPill } from './AiStatusPill';
import {
  callOutcome,
  limitsSentence,
  planStepTitles,
  planText,
  toolLabel,
  userFacingAgentText,
} from './agentLanguage';
import { SCOPE_ICONS } from './scopeIcons';
import { useAiAvailability } from './useAiAvailability';

/** The three jobs worth offering, per view. A student looking at their to-do
 * list is not there to file notes into courses, and an example of work they
 * did not come to do reads as a feature that does not know where it is. */
const SUGGESTIONS = ['tidy', 'recap', 'tag'] as const;
const TASK_SUGGESTIONS = ['plan', 'catchUp', 'fromNotes'] as const;

/** Same ceiling as the Ask composer: four or five lines, then the task matters
 * less than what the agent is doing with it. */
const COMPOSER_MAX_HEIGHT = 108;

export function AgentPanel({
  noteId,
  /** Set where Ask is not an option — the Tasks view has no open note, so the
   * AI tab there *is* the agent and a switch out of it leads nowhere. */
  agentOnly = false,
}: {
  noteId: string | null;
  agentOnly?: boolean;
}) {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const selection = useUiStore((state) => state.multiSelection);
  const scope = useAiStore((state) => state.askScope);
  const setScope = useAiStore((state) => state.setAskScope);
  const setAgentMode = useAiStore((state) => state.setAgentMode);
  const busy = useAiStore((state) => state.running) === 'agent';
  const run = useAgentStore((state) =>
    state.runs.find((entry) => entry.id === state.activeRunId),
  );
  const availability = useAiAvailability('agent');

  const [instruction, setInstruction] = useState('');
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState('');
  const [requiredScope, setRequiredScope] = useState<'library' | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Derived rather than held: a run survives this component, so local `planning`
  // and `running` flags would come back false after a remount while the agent
  // was still working.
  const planning = busy && !run;
  const running = busy && run?.status === 'running';

  useEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [instruction]);

  const courseId = note?.courseId ?? null;
  const selected = selection.length > 1 ? selection : null;

  /**
   * What the run will *actually* be scoped to.
   *
   * The scope control is shared with Ask, where "this note" always means
   * something because Ask cannot open without a note. The agent can — the
   * shortcut works from an empty editor — and a popup reading "This note" over
   * a run the executor would widen to the whole library is the one lie this
   * surface must not tell. Both the control and the plan request read this.
   */
  const effective: AskScope =
    (scope === 'note' && !noteId && !selected) || (scope === 'course' && !courseId)
      ? 'library'
      : scope;

  async function plan(followUpTo?: string) {
    const asked = instruction.trim();
    if (!asked) return;
    setError('');
    setRequiredScope(null);
    if (followUpTo) useAgentStore.getState().setActiveRun(null);
    const signal = beginRun('agent');
    const response = await planAgentCommand(
      {
        instruction: asked,
        scope: agentScope(effective, noteId, selected, courseId),
        budget: DEFAULT_AGENT_BUDGET,
        followUpTo,
      },
      { signal },
    );
    endRun('agent', signal);
    if (response.ok) {
      setInstruction('');
      return;
    }
    if (followUpTo) useAgentStore.getState().setActiveRun(followUpTo);
    if (!response.ok && response.code !== 'cancelled') {
      if (response.code === 'scope_denied' && requiresLibrary(response.details)) {
        setRequiredScope('library');
        setError(t('agent.scopeRequiredLibrary'));
        return;
      }
      setError(
        response.code === 'not_supported'
          ? t('ai.notConfiguredHint')
          : (userFacingAgentText(response.message) ?? t('agent.errorFallback')),
      );
    }
  }

  async function execute() {
    if (!run) return;
    setError('');
    const signal = beginRun('agent');
    const response = await runAgentCommand(run.id, { signal });
    endRun('agent', signal);
    if (!response.ok && response.code !== 'cancelled') {
      setError(userFacingAgentText(response.message) ?? t('agent.errorFallback'));
    }
  }

  async function undo() {
    if (!run) return;
    setUndoing(true);
    setError('');
    const response = await undoAgentRunCommand(run.id);
    setUndoing(false);
    if (!response.ok) {
      setError(userFacingAgentText(response.message) ?? t('agent.errorFallback'));
    }
    else await useLibraryStore.getState().refreshCurrentView();
  }

  /** Back to the composer. `keep` carries the wording over, which is what
   * "change the task" means — the plan was nearly right. */
  function reset(keep: boolean) {
    useAgentStore.getState().setActiveRun(null);
    setInstruction(keep && run ? run.instruction : '');
    setError('');
    setRequiredScope(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function openTouchedNote(touched: AgentRunRecord['touchedNotes'][number]) {
    const ui = useUiStore.getState();
    ui.requestVersionSnapshot(touched.snapshotId);
    ui.selectNote(touched.noteId);
    await useEditorStore.getState().openNote(touched.noteId);
    ui.setInspectorTab(touched.snapshotId ? 'versions' : 'info');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="-ml-1.5 flex items-center gap-0.5">
        <GlassPopupButton<AskScope>
          label={t('agent.scope')}
          value={effective}
          onChange={(next) => {
            setScope(next);
            if (next === 'library') {
              setRequiredScope(null);
              setError('');
            }
          }}
          disabled={running || planning}
          icon={SCOPE_ICONS[effective]}
          className="shrink"
          options={[
            {
              value: 'note',
              // "This note" widens to the bulk selection when there is one, the
              // way every other action in the app already does.
              label: selected
                ? t('agent.scopeSelection', { count: selected.length })
                : t('ai.askScopeNote'),
              disabled: !noteId && !selected,
            },
            {
              value: 'course',
              label: t('ai.askScopeCourse'),
              disabled: !courseId,
              title: courseId ? undefined : t('ai.askScopeCourseDisabled'),
            },
            { value: 'library', label: t('ai.askScopeLibrary') },
          ]}
        />
        {!agentOnly && (
          <AiModeSwitch
            label={t('ai.agentSwitch')}
            title={t('ai.agentSwitchHint')}
            checked
            className="ml-auto"
            onChange={() => setAgentMode(false)}
          />
        )}
        {run && !running && (
          <button
            type="button"
            aria-label={t('agent.newTask')}
            title={t('agent.newTask')}
            onClick={() => reset(false)}
            className="grid size-7 shrink-0 place-items-center rounded-nb-xs text-nb-text-3 transition-colors duration-[var(--nb-t-fast)] hover:bg-[var(--nb-hover)] hover:text-nb-text-2"
          >
            <Plus size={13} aria-hidden />
          </button>
        )}
      </div>

      <div className="-mx-0.5 min-h-0 flex-1 space-y-2.5 overflow-y-auto px-0.5">
        {run ? (
          <RunView run={run} running={running} onOpenNote={openTouchedNote} />
        ) : planning ? (
          // The spinner is in the send button, which is 7px of motion at the
          // bottom of an otherwise unchanged panel. Say what it is doing.
          <p
            role="status"
            className="flex items-center gap-2 px-1 pt-5 text-[11.5px] text-nb-text-3"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden />
            {t('agent.planning')}
          </p>
        ) : (
          <EmptyState
            disabled={!availability.available}
            taskContext={agentOnly}
            onPick={(text) => {
              setInstruction(text);
              composerRef.current?.focus();
            }}
          />
        )}
        {error && (
          <div
            role="alert"
            className="rounded-nb-xs bg-[color-mix(in_srgb,var(--nb-danger)_10%,transparent)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--nb-danger)]"
          >
            <p>{error}</p>
            {requiredScope === 'library' && (
              <button
                type="button"
                onClick={() => {
                  setScope('library');
                  setRequiredScope(null);
                  setError('');
                  window.setTimeout(() => composerRef.current?.focus(), 0);
                }}
                className="mt-1.5 rounded-nb-xs bg-[var(--nb-paper)] px-2 py-1 font-medium text-[var(--nb-accent)] transition-colors duration-[var(--nb-t-fast)] hover:bg-[var(--nb-hover)]"
              >
                {t('agent.useLibraryScope')}
              </button>
            )}
          </div>
        )}
      </div>

      {run ? (
        <>
          <RunActions
            run={run}
            running={running}
            undoing={undoing}
            canRun={availability.available}
            onRun={() => void execute()}
            onStop={() => cancelRun('agent')}
            onUndo={() => void undo()}
            onEdit={() => reset(true)}
          />
          {run.status !== 'planned' && run.status !== 'running' && (
            <AgentComposer
              inputRef={composerRef}
              value={instruction}
              disabled={!availability.available}
              placeholder={t('agent.followUpPlaceholder')}
              label={t('agent.followUp')}
              submitLabel={t('agent.planFollowUp')}
              onChange={setInstruction}
              onSubmit={() => void plan(run.id)}
            />
          )}
        </>
      ) : (
        <AgentComposer
          inputRef={composerRef}
          value={instruction}
          disabled={!availability.available || planning}
          planning={planning}
          placeholder={t('agent.placeholder')}
          label={t('agent.title')}
          submitLabel={t('agent.makePlan')}
          onChange={setInstruction}
          onSubmit={() => void plan()}
        />
      )}
    </div>
  );
}

function AgentComposer({
  inputRef,
  value,
  disabled,
  planning = false,
  placeholder,
  label,
  submitLabel,
  onChange,
  onSubmit,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  disabled: boolean;
  planning?: boolean;
  placeholder: string;
  label: string;
  submitLabel: string;
  onChange(value: string): void;
  onSubmit(): void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] p-1.5',
        'transition-colors duration-[var(--nb-t-fast)]',
        'focus-within:border-[var(--nb-accent)]',
        disabled && 'opacity-60',
      )}
    >
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        title={t('ai.composerHint')}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter still plans rather than executes, including for follow-ups.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        className="block w-full resize-none bg-transparent px-1 py-0.5 text-[12.5px] leading-relaxed outline-none placeholder:text-nb-text-3"
      />
      <div className="mt-1 flex items-center justify-end gap-1.5">
        <AiStatusPill feature="agent" modelOnly className="min-w-0" />
        <AiDisclosureButton />
        <GlassButton
          size="sm"
          variant={planning ? 'default' : 'accent'}
          aria-label={planning ? t('agent.stop') : submitLabel}
          title={planning ? t('agent.stop') : submitLabel}
          disabled={!planning && (!value.trim() || disabled)}
          onClick={() => (planning ? cancelRun('agent') : onSubmit())}
          className="size-7 shrink-0 rounded-full px-0"
        >
          {planning ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Send size={12} />
          )}
        </GlassButton>
      </div>
    </div>
  );
}

function requiresLibrary(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    'requiredScope' in details &&
    details.requiredScope === 'library'
  );
}

/** Which notes the run may touch. The three-way Ask scope maps onto the agent's
 * own scopes; a bulk selection takes over "this note" because that is what the
 * student has in front of them. */
function agentScope(
  scope: AskScope,
  noteId: string | null,
  selected: string[] | null,
  courseId: string | null,
): AgentScope {
  if (scope === 'library') return { kind: 'library' };
  if (scope === 'course' && courseId) return { kind: 'course', courseId };
  const noteIds = selected ?? (noteId ? [noteId] : []);
  return noteIds.length ? { kind: 'selection', noteIds } : { kind: 'library' };
}

function EmptyState({
  disabled,
  taskContext,
  onPick,
}: {
  disabled: boolean;
  /** The Tasks view, where the work in front of the student is a deadline. */
  taskContext: boolean;
  onPick(instruction: string): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center px-1 pt-5 text-center">
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-full bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]"
      >
        <Bot size={16} />
      </span>
      <p className="mt-2.5 text-[13px] font-semibold">{t('agent.emptyTitle')}</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-nb-text-3">
        {t('agent.emptyIntro')}
      </p>
      <div className="mt-3.5 flex w-full flex-col gap-1">
        {(taskContext ? TASK_SUGGESTIONS : SUGGESTIONS).map((key) => {
          const suggestion = t(`agent.suggestion_${key}`);
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onPick(suggestion)}
              className={cn(
                'rounded-nb-xs border border-[var(--nb-divider)] px-2.5 py-1.5',
                'text-left text-[11.5px] text-nb-text-2',
                'transition-colors duration-[var(--nb-t-fast)]',
                'hover:border-[var(--nb-divider-strong)] hover:bg-[var(--nb-hover)] hover:text-nb-text',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              {suggestion}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RunView({
  run,
  running,
  onOpenNote,
}: {
  run: AgentRunRecord;
  running: boolean;
  onOpenNote(touched: AgentRunRecord['touchedNotes'][number]): void;
}) {
  const { t } = useTranslation();
  const planSummary = userFacingAgentText(planText(run.plan, run.plan.summary));

  return (
    <>
      <section className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-2.5">
        <Eyebrow>{t(run.parentRunId ? 'agent.followUp' : 'agent.asked')}</Eyebrow>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-nb-text-3">
          {run.instruction}
        </p>

        <p className="mt-2.5 text-[12.5px] font-semibold leading-snug">
          {planSummary ?? t('agent.planFallback')}
        </p>
        <ol className="mt-2 space-y-1.5">
          {run.plan.steps.map((step, index) => {
            const titles = planStepTitles(run.plan, step);
            const description = userFacingAgentText(
              planText(run.plan, step.description),
            );
            return (
              <li key={index} className="flex gap-1.5 text-[11.5px] leading-relaxed">
                <span className="mt-[3px] grid size-[15px] shrink-0 place-items-center rounded-full bg-[var(--nb-hover)] text-[9px] text-nb-text-3">
                  {index + 1}
                </span>
                <span className="min-w-0 text-nb-text-2">
                  {description}
                  {titles.length > 0 && (
                    <span className="ml-1 text-[10.5px] text-nb-text-3">
                      {titles.map((title) => `“${title}”`).join(' · ')}
                    </span>
                  )}
                  {step.expectedTools.length > 0 && (
                    <span className="ml-1 text-[10.5px] text-nb-text-3">
                      {step.expectedTools.map((tool) => toolLabel(tool, t)).join(' · ')}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>

        {/* The ceilings, as a sentence. They were a four-column grid of numbers
            headed "Token ceiling", which is a unit nobody outside this file
            thinks in — the exact figures moved to the details disclosure. */}
        <p className="mt-2.5 rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-1.5 text-[10.5px] leading-relaxed text-nb-text-3">
          {limitsSentence(run, t)}
        </p>
      </section>

      {run.status !== 'planned' && (
        <section>
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>{t(running ? 'agent.activityLive' : 'agent.activityDone')}</Eyebrow>
            <StatusLabel status={run.status} />
          </div>
          {run.calls.length ? (
            <ul className="mt-1.5 space-y-1">
              {run.calls.map((call) => {
                const outcome = callOutcome(call, run, t);
                const rationale = userFacingAgentText(call.rationale);
                const callError = call.error
                  ? (userFacingAgentText(call.error) ?? t('agent.stepErrorFallback'))
                  : null;
                return (
                  <li
                    key={call.id}
                    className="rounded-nb-xs border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-2 py-1.5"
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="mt-[1px] shrink-0">
                        <CallIcon status={call.status} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11.5px] font-medium leading-snug text-nb-text-2">
                          {toolLabel(call.tool, t)}
                        </p>
                        {rationale && (
                          <p className="mt-0.5 text-[11px] leading-relaxed text-nb-text-3">
                            {rationale}
                          </p>
                        )}
                        {(outcome || callError) && (
                          <p
                            className={cn(
                              'mt-0.5 text-[10.5px] leading-relaxed',
                              callError ? 'text-[var(--nb-danger)]' : 'text-nb-text-3',
                            )}
                          >
                            {callError ?? outcome}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : running ? (
            <p className="mt-1.5 flex items-center gap-2 text-[11.5px] text-nb-text-3">
              <Loader2 size={12} className="animate-spin" /> {t('agent.thinking')}
            </p>
          ) : null}
        </section>
      )}

      {(run.summary || run.error || run.touchedNotes.length > 0) && (
        <section className="rounded-nb-sm bg-[var(--nb-inset-surface)] px-3 py-2.5">
          <Eyebrow>{t('agent.result')}</Eyebrow>
          {run.summary && (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-nb-text-2">
              {userFacingAgentText(run.summary) ?? t('agent.resultFallback')}
            </p>
          )}
          {run.error && (
            <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--nb-danger)]">
              <AlertCircle size={11} className="mt-0.5 shrink-0" aria-hidden />
              {userFacingAgentText(run.error) ?? t('agent.errorFallback')}
            </p>
          )}
          {run.touchedNotes.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {run.touchedNotes.map((touched) => (
                <li key={touched.noteId}>
                  <button
                    type="button"
                    onClick={() => onOpenNote(touched)}
                    title={touched.snapshotId ? t('agent.openDiff') : t('agent.openNote')}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-nb-xs px-1 py-1',
                      'text-left text-[11px] text-nb-text-2',
                      'transition-colors duration-[var(--nb-t-fast)]',
                      'hover:bg-[var(--nb-hover)] hover:text-[var(--nb-accent)]',
                    )}
                  >
                    <FileClock
                      size={11}
                      aria-hidden
                      className="shrink-0 text-nb-text-3"
                    />
                    <span className="truncate">
                      {touched.title || t('editor.untitled')}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-nb-text-3">
                      {touched.created ? t('agent.created') : t('agent.changed')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

/** The buttons that replace the composer once a run exists. They sit where the
 * composer sat, outside the scroll area, so the thing you press next is never
 * below the fold. */
function RunActions({
  run,
  running,
  undoing,
  canRun,
  onRun,
  onStop,
  onUndo,
  onEdit,
}: {
  run: AgentRunRecord;
  running: boolean;
  undoing: boolean;
  canRun: boolean;
  onRun(): void;
  onStop(): void;
  onUndo(): void;
  onEdit(): void;
}) {
  const { t } = useTranslation();
  const canUndo =
    run.status !== 'planned' &&
    run.status !== 'running' &&
    run.status !== 'undone' &&
    (run.touchedNotes.length > 0 ||
      run.undoJournal.createdCourses.length > 0 ||
      run.undoJournal.createdSections.length > 0 ||
      run.undoJournal.createdTagIds.length > 0 ||
      run.undoJournal.tagsBeforeRename.length > 0);

  if (running) {
    return (
      <GlassButton size="sm" onClick={onStop} className="w-full justify-center">
        <Square size={11} aria-hidden />
        {t('agent.stop')}
      </GlassButton>
    );
  }

  if (run.status === 'planned') {
    return (
      <div className="flex items-center gap-1.5">
        <GlassButton size="sm" variant="ghost" onClick={onEdit} className="shrink-0">
          {t('agent.changeTask')}
        </GlassButton>
        <GlassButton
          size="sm"
          variant="accent"
          disabled={!canRun}
          onClick={onRun}
          className="min-w-0 flex-1 justify-center"
        >
          <Sparkles size={11} aria-hidden />
          {t('agent.runPlan')}
        </GlassButton>
      </div>
    );
  }

  if (!canUndo) return null;

  return (
    <GlassButton
      size="sm"
      disabled={undoing}
      onClick={onUndo}
      className="w-full justify-center"
    >
      {undoing ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <RotateCcw size={11} aria-hidden />
      )}
      {undoing ? t('agent.undoing') : t('agent.undoRun')}
    </GlassButton>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[9.5px] font-medium uppercase tracking-[0.06em] text-nb-text-3">
      {children}
    </p>
  );
}

function StatusLabel({ status }: { status: AgentRunRecord['status'] }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--nb-hover)] px-1.5 py-0.5 text-[10px] text-nb-text-3">
      {status === 'running' && <Loader2 size={9} className="animate-spin" />}
      {t(`agent.status_${status}`)}
    </span>
  );
}

function CallIcon({ status }: { status: AgentRunRecord['calls'][number]['status'] }) {
  if (status === 'running')
    return <Loader2 size={11} className="animate-spin text-[var(--nb-accent)]" />;
  if (status === 'succeeded')
    return <Check size={11} className="text-[var(--nb-success)]" />;
  if (status === 'failed') return <X size={11} className="text-[var(--nb-danger)]" />;
  return <Square size={9} className="text-nb-text-3" />;
}
