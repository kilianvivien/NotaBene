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
  ChevronRight,
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
import { ChoiceGroup, GlassButton, GlassPopupButton } from '@/components/glass';
import { DEFAULT_AGENT_BUDGET } from '@/lib/ai';
import type { AskScope } from '@/lib/ai';
import {
  answerAgentQuestionCommand,
  applyAgentChangesetCommand,
  discardAgentChangesetCommand,
  planAgentCommand,
  runAgentCommand,
  undoAgentRunCommand,
} from '@/lib/commands';
import { summarizeChangeset } from '@/lib/commands/agentChangeset';
// The same test the command layer applies before it accepts "done", so the
// live line can say the agent is wrapping up rather than looking for work.
import { missingSuccessfulPlanTools } from '@/lib/commands/agentCommands';
import { tagLabel } from '@/lib/notes/tagLabel';
import { TAG_NAMESPACES, type TagNamespace } from '@/lib/schema';
import type { AgentRunRecord, AgentScope } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiDisclosureButton } from './AiDisclosure';
import { aiErrorMessage } from './aiErrorMessage';
import { AiModeSwitch } from './AiModeSwitch';
import { AiStatusPill } from './AiStatusPill';
import {
  agentErrorText,
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
  const [applying, setApplying] = useState(false);
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
          ? aiErrorMessage(response, t)
          : (agentErrorText(response.message) ?? t('agent.errorFallback')),
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
      setError(agentErrorText(response.message) ?? t('agent.errorFallback'));
    }
  }

  async function undo() {
    if (!run) return;
    setUndoing(true);
    setError('');
    const response = await undoAgentRunCommand(run.id);
    setUndoing(false);
    if (!response.ok) {
      setError(agentErrorText(response.message) ?? t('agent.errorFallback'));
    } else await useLibraryStore.getState().refreshCurrentView();
  }

  async function applyChanges() {
    if (!run) return;
    setApplying(true);
    setError('');
    const response = await applyAgentChangesetCommand(run.id);
    setApplying(false);
    if (!response.ok) setError(agentErrorText(response.message) ?? t('agent.errorFallback'));
  }

  function discardChanges() {
    if (!run) return;
    const response = discardAgentChangesetCommand(run.id);
    if (!response.ok) setError(agentErrorText(response.message) ?? t('agent.errorFallback'));
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
            applying={applying}
            canRun={availability.available}
            onRun={() => void execute()}
            onStop={() => cancelRun('agent')}
            onUndo={() => void undo()}
            onEdit={() => reset(true)}
            onApply={() => void applyChanges()}
            onDiscard={discardChanges}
          />
          {run.status !== 'planned' &&
            run.status !== 'running' &&
            run.changeset?.state !== 'pending' && (
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
          {planning ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
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
  const gate = run.status === 'planned';
  // Between two calls the run is waiting on the model, and nothing in the list
  // moves. Saying so is what separates "still working" from "stuck" — without
  // it, a finished-looking list over a Stop button read as a run that had
  // already ended.
  const waiting =
    running && !run.pendingQuestion && !run.calls.some((call) => call.status === 'running');

  const steps = (
    <ol className="space-y-1.5">
      {run.plan.steps.map((step, index) => {
        const titles = planStepTitles(run.plan, step);
        const description = userFacingAgentText(planText(run.plan, step.description));
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
              {gate && step.expectedTools.length > 0 && (
                <span className="ml-1 text-[10.5px] text-nb-text-3">
                  {step.expectedTools.map((tool) => toolLabel(tool, t)).join(' · ')}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );

  return (
    <>
      {gate ? (
        <section className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-3 py-2.5">
          <Eyebrow>{t(run.parentRunId ? 'agent.followUp' : 'agent.asked')}</Eyebrow>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-nb-text-3">
            {run.instruction}
          </p>

          <p className="mt-2.5 text-[12.5px] font-semibold leading-snug">
            {planSummary ?? t('agent.planFallback')}
          </p>
          <div className="mt-2">{steps}</div>

          {/* The ceilings, as a sentence. They were a four-column grid of numbers
              headed "Token ceiling", which is a unit nobody outside this file
              thinks in — the exact figures moved to the details disclosure. */}
          <p className="mt-2.5 rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-1.5 text-[10.5px] leading-relaxed text-nb-text-3">
            {limitsSentence(run, t)}
          </p>
          {/* On the gate, so a plan's origin is legible: a step the student did
              not ask for may have come from a convention they set weeks ago. */}
          {run.standingInstructions && (
            <details className="mt-2 text-[10.5px] leading-relaxed text-nb-text-3">
              <summary className="cursor-pointer">
                {t('agent.instructions.applied')}
              </summary>
              <p className="mt-1 whitespace-pre-wrap rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-1.5">
                {run.standingInstructions}
              </p>
              <button
                type="button"
                className="mt-1 text-[var(--nb-accent)] underline-offset-2 hover:underline"
                onClick={() => {
                  useUiStore.getState().setSettingsTab('agent');
                  useUiStore.getState().setSettingsOpen(true);
                }}
              >
                {t('agent.instructions.edit')}
              </button>
            </details>
          )}
        </section>
      ) : (
        // Once the plan was approved it is context, not a decision: the task and
        // the plan's one-line summary, with the steps a click away.
        <section className="px-1">
          <p
            className="line-clamp-2 text-[11.5px] leading-relaxed text-nb-text-3"
            title={run.instruction}
          >
            {run.instruction}
          </p>
          <details className="group mt-1">
            <summary className="flex cursor-pointer list-none items-baseline gap-1.5 text-[12px] font-semibold leading-snug [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={11}
                aria-hidden
                className="shrink-0 translate-y-[1px] text-nb-text-3 transition-transform duration-[var(--nb-t-fast)] group-open:rotate-90"
              />
              <span className="min-w-0">{planSummary ?? t('agent.planFallback')}</span>
              <span className="ml-auto shrink-0 text-[10px] font-normal text-nb-text-3">
                {t('agent.planSteps', { count: run.plan.steps.length })}
              </span>
            </summary>
            <div className="mt-1.5 pl-4">{steps}</div>
          </details>
        </section>
      )}

      {running && run.pendingQuestion && <QuestionCard run={run} />}

      {!gate && (
        <section>
          <div className="flex items-center justify-between gap-2 px-1">
            <Eyebrow>{t(running ? 'agent.activityLive' : 'agent.activityDone')}</Eyebrow>
            <StatusLabel status={run.status} />
          </div>
          <ul className="mt-1 divide-y divide-[var(--nb-divider)] rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-paper)] empty:hidden">
            {run.calls.map((call) => (
              <CallRow key={call.id} call={call} run={run} />
            ))}
            {waiting && (
              <li
                role="status"
                className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-nb-text-3"
              >
                <Loader2 size={11} className="shrink-0 animate-spin text-[var(--nb-accent)]" />
                <span className="truncate">
                  {t(
                    run.calls.some((call) => call.status === 'succeeded') &&
                      !missingSuccessfulPlanTools(run.plan, run.calls).length
                      ? 'agent.finishing'
                      : 'agent.thinking',
                  )}
                </span>
              </li>
            )}
          </ul>
          {(run.questions ?? []).length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {(run.questions ?? []).map((entry, index) => (
                <li
                  key={index}
                  className="rounded-nb-xs border border-dashed border-[var(--nb-divider)] px-2 py-1.5 text-[11px] leading-relaxed"
                >
                  <p className="text-nb-text-2">{entry.question}</p>
                  <p className="mt-0.5 text-nb-text-3">
                    {t('agent.question.answered', { answer: entry.answer ?? '—' })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {run.changeset && run.changeset.state !== 'staging' && (
        <ChangesetCard changeset={run.changeset} />
      )}

      {/* Not while running: a Result box under a live run is what made one look
          finished while the agent was still deciding whether it was. */}
      {!running && (run.summary || run.error || run.touchedNotes.length > 0) && (
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
              {agentErrorText(run.error) ?? t('agent.errorFallback')}
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

/**
 * One call, on one line: what happened when it did ("Read “Journée
 * Outre-mer”"), what it was doing when it has not finished. The model's
 * rationale — usually a paragraph restating the plan step — is a click away;
 * as three lines under every call it filled the column with the plan twice.
 * An error stays visible, because it is the line the student needs.
 */
function CallRow({
  call,
  run,
}: {
  call: AgentRunRecord['calls'][number];
  run: AgentRunRecord;
}) {
  const { t } = useTranslation();
  const outcome = callOutcome(call, run, t);
  const rationale = userFacingAgentText(call.rationale);
  const callError = call.error
    ? (agentErrorText(call.error) ?? t('agent.stepErrorFallback'))
    : null;
  const line = outcome ?? toolLabel(call.tool, t);
  const head = (
    <>
      <span className="shrink-0 translate-y-[1px]">
        <CallIcon status={call.status} />
      </span>
      <span className="min-w-0 flex-1 truncate">{line}</span>
    </>
  );

  return (
    <li className="px-2 py-1.5 text-[11px] leading-snug text-nb-text-2">
      {rationale ? (
        <details className="group">
          <summary
            title={rationale}
            className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden"
          >
            {head}
            <ChevronRight
              size={10}
              aria-hidden
              className="shrink-0 text-nb-text-3 opacity-60 transition-transform duration-[var(--nb-t-fast)] group-open:rotate-90"
            />
          </summary>
          <p className="mt-1 pl-[17px] text-[10.5px] leading-relaxed text-nb-text-3">
            {rationale}
          </p>
        </details>
      ) : (
        <div className="flex items-center gap-1.5">{head}</div>
      )}
      {callError && (
        <p className="mt-0.5 pl-[17px] text-[10.5px] leading-relaxed text-[var(--nb-danger)]">
          {callError}
        </p>
      )}
    </li>
  );
}

/**
 * The question a running agent is waiting on (plan §3.2, item 3).
 *
 * The model's options are cards because each is a different outcome, and a
 * field below takes anything else — the model cannot know every answer a
 * student might give. The run's wall clock is paused meanwhile; Stop, below,
 * still cancels.
 */
function QuestionCard({ run }: { run: AgentRunRecord }) {
  const { t } = useTranslation();
  const question = run.pendingQuestion!;
  const [choice, setChoice] = useState('');
  const [typed, setTyped] = useState('');
  const answer = typed.trim() || choice;

  function send() {
    if (!answer) return;
    answerAgentQuestionCommand(run.id, answer);
    setChoice('');
    setTyped('');
  }

  return (
    <section
      aria-live="polite"
      className="rounded-nb-sm border border-[var(--nb-accent)] bg-[var(--nb-accent-soft)] px-3 py-2.5"
    >
      <Eyebrow>{t('agent.question.title')}</Eyebrow>
      <p className="mt-0.5 text-[12.5px] font-semibold leading-snug">
        {question.question}
      </p>
      {question.options.length > 0 && (
        <ChoiceGroup
          className="mt-2"
          label={question.question}
          value={choice}
          onChange={(value) => {
            setChoice(value);
            setTyped('');
          }}
          columns={1}
          options={question.options.map((option) => ({ value: option, title: option }))}
        />
      )}
      <textarea
        rows={2}
        value={typed}
        placeholder={t(
          question.options.length
            ? 'agent.question.otherPlaceholder'
            : 'agent.question.placeholder',
        )}
        aria-label={t('agent.question.placeholder')}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
        className="mt-2 w-full resize-none rounded-nb-xs border border-[var(--nb-divider)] bg-[var(--nb-paper)] px-2 py-1.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]"
      />
      <div className="mt-1.5 flex justify-end">
        <GlassButton size="sm" variant="accent" disabled={!answer} onClick={send}>
          <Send size={12} aria-hidden /> {t('agent.question.send')}
        </GlassButton>
      </div>
    </section>
  );
}

/**
 * What a run set aside for review (plan §3.2 item 8), in the terms the student
 * decides in — *23 notes → Constitutional Law / Week 4, 6 archived* — never
 * as a list of calls. The buttons are in `RunActions`, outside the scroll.
 */
function ChangesetCard({
  changeset,
}: {
  changeset: NonNullable<AgentRunRecord['changeset']>;
}) {
  const { t } = useTranslation();
  const courses = useLibraryStore((state) => state.courses);
  const sections = useLibraryStore((state) => state.sections);
  const tags = useLibraryStore((state) => state.tags);
  const summary = summarizeChangeset(changeset.calls);
  const pending = changeset.state === 'pending';

  function destination(courseId: string | null, sectionId: string | null): string {
    if (!courseId) return t('sidebar.inbox');
    const course = courses.find((entry) => entry.id === courseId);
    if (!course) return t('agent.changeset.unknownDestination');
    const section = sectionId
      ? (sections[courseId] ?? []).find((entry) => entry.id === sectionId)
      : undefined;
    return section ? `${course.name} / ${section.name}` : course.name;
  }

  function addedTag(raw: string): string {
    const [maybeNamespace, ...rest] = raw.split(':');
    const namespace = TAG_NAMESPACES.includes(maybeNamespace as TagNamespace)
      ? (maybeNamespace as TagNamespace)
      : null;
    return tagLabel(
      namespace && rest.length ? { namespace, name: rest.join(':') } : { namespace: null, name: raw },
      t,
    ).full;
  }

  function removedTag(tagId: string): string {
    const tag = tags.find((entry) => entry.id === tagId);
    return tag ? tagLabel(tag, t).full : t('agent.changeset.unknownDestination');
  }

  const lines = [
    ...summary.moves.map((move) =>
      t('agent.changeset.move', {
        count: move.count,
        destination: destination(move.courseId, move.sectionId),
      }),
    ),
    ...summary.tagsAdded.map((entry) =>
      t('agent.changeset.tagAdded', { count: entry.count, tag: addedTag(entry.name) }),
    ),
    ...summary.tagsRemoved.map((entry) =>
      t('agent.changeset.tagRemoved', { count: entry.count, tag: removedTag(entry.tagId) }),
    ),
    ...(summary.archived ? [t('agent.changeset.archived', { count: summary.archived })] : []),
    ...(summary.unarchived
      ? [t('agent.changeset.unarchived', { count: summary.unarchived })]
      : []),
    ...(summary.trashed ? [t('agent.changeset.trashed', { count: summary.trashed })] : []),
  ];
  const skipped = changeset.skipped?.length ?? 0;

  return (
    <section
      aria-live="polite"
      className={cn(
        'rounded-nb-sm px-3 py-2.5',
        pending
          ? 'border border-[var(--nb-accent)] bg-[var(--nb-accent-soft)]'
          : 'border border-[var(--nb-divider)] bg-[var(--nb-paper)]',
      )}
    >
      <Eyebrow>{t('agent.changeset.title')}</Eyebrow>
      {pending && (
        <p className="mt-0.5 text-[11px] leading-relaxed text-nb-text-3">
          {t('agent.changeset.intro', { count: summary.notes })}
        </p>
      )}
      <ul className="mt-1.5 space-y-0.5 text-[11.5px] leading-relaxed text-nb-text-2">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {!pending && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-nb-text-3">
          {t(
            changeset.state === 'applied'
              ? 'agent.changeset.applied'
              : 'agent.changeset.discarded',
          )}
          {skipped > 0 && ` ${t('agent.changeset.skipped', { count: skipped })}`}
        </p>
      )}
    </section>
  );
}

/** The buttons that replace the composer once a run exists. They sit where the
 * composer sat, outside the scroll area, so the thing you press next is never
 * below the fold. */
function RunActions({
  run,
  running,
  undoing,
  applying,
  canRun,
  onRun,
  onStop,
  onUndo,
  onEdit,
  onApply,
  onDiscard,
}: {
  run: AgentRunRecord;
  running: boolean;
  undoing: boolean;
  applying: boolean;
  canRun: boolean;
  onRun(): void;
  onStop(): void;
  onUndo(): void;
  onEdit(): void;
  onApply(): void;
  onDiscard(): void;
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

  // The changeset is the decision in front of the student; undo of whatever
  // else the run wrote stays available after it, not instead of it.
  if (run.changeset?.state === 'pending') {
    return (
      <div className="flex items-center gap-1.5">
        <GlassButton
          size="sm"
          variant="ghost"
          disabled={applying}
          onClick={onDiscard}
          className="shrink-0"
        >
          {t('agent.changeset.cancel')}
        </GlassButton>
        <GlassButton
          size="sm"
          variant="accent"
          disabled={applying}
          onClick={onApply}
          className="min-w-0 flex-1 justify-center"
        >
          {applying ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Check size={11} aria-hidden />
          )}
          {applying ? t('agent.changeset.applying') : t('agent.changeset.apply')}
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
