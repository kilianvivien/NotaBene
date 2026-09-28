/**
 * Command-layer coordinator for the in-app agent.
 *
 * Model turns live in `lib/ai/agent.ts`; every tool invocation comes back
 * through `executeToolHandler`, the same door as MCP. This layer adds the two
 * things an in-app run needs that a remote client supplies for itself: scope
 * enforcement and a durable undo journal.
 */
import { library } from '@/lib/adapters';
import {
  AgentBudgetError,
  AgentScopeError,
  AiParseError,
  BUDGET_EXHAUSTED,
  DEFAULT_AGENT_BUDGET,
  estimateTokens,
  agentToolDefinitions,
  requestAgentPlan,
  runAgentLoop,
  usesNativeTools,
  type AgentFollowUpContext,
  type AiRunOptions,
  type AgentToolOutcome,
} from '@/lib/ai';
import { agentToolParameters, executeToolHandler } from '@/lib/mcp/toolHandlers';
import {
  AgentScopeSchema,
  MAX_AGENT_QUESTIONS,
  newId,
  type AgentBudget,
  type AgentPlan,
  type AgentPlanDraft,
  type AgentQuestion,
  type AgentRunRecord,
  type AgentScope,
  type AgentToolCallRecord,
  type AgentToolName,
  type Course,
  type Note,
  type Section,
  type Tag,
} from '@/lib/schema';
import i18n from '@/lib/i18n';
import { useAgentStore } from '@/lib/state/agentStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import { aiFailure, language, providerFor } from './aiCommands';
import { restoreNotesCommand, trashNotesCommand } from './bulkCommands';
import {
  deleteCourseCommand,
  deleteSectionCommand,
  deleteTagCommand,
  updateTagCommand,
} from './organizationCommands';
import { updateNoteCommand } from './noteCommands';
import {
  CHANGESET_REVIEW_THRESHOLD,
  STAGEABLE_TOOLS,
  changesetNoteIds,
  planStagesChanges,
  splitForStaging,
  stagedRefs,
  withoutNotes,
} from './agentChangeset';
import { fail, ok, type CommandResult } from './types';

export interface PlanAgentInput {
  instruction: string;
  scope?: AgentScope;
  budget?: AgentBudget;
  followUpTo?: string;
}

class AgentCompletionError extends Error {
  constructor(readonly missingTools: AgentToolName[]) {
    super('the approved plan did not complete');
    this.name = 'AgentCompletionError';
  }
}

/** A course is a library container, so no selected-note or course-scoped plan
 * may promise to create one. The refusal happens before a run is reviewable. */
export function requiredScopeForPlan(plan: AgentPlan): 'library' | null {
  return plan.steps.some((step) => step.expectedTools.includes('create_course'))
    ? 'library'
    : null;
}

/** Resolve generated ids through library-owned titles and remove them from all
 * prose before the plan reaches the review UI or the durable run journal. */
export function finalizeAgentPlan(
  draft: AgentPlanDraft,
  availableReferences: AgentPlan['noteReferences'],
): AgentPlan {
  const known = new Map(
    availableReferences.map((reference) => [reference.noteId, reference.title]),
  );
  const used = new Set<string>();
  const clean = (value: string): string => {
    let visible = value;
    for (const [noteId, title] of known) {
      if (!visible.includes(noteId)) continue;
      used.add(noteId);
      visible = visible.split(noteId).join(title);
    }
    return visible;
  };

  const summary = clean(draft.summary);
  const steps = draft.steps.map((step) => {
    const idsWrittenInDescription = availableReferences
      .filter((reference) => step.description.includes(reference.noteId))
      .map((reference) => reference.noteId);
    const noteIds = [...new Set([...step.noteIds, ...idsWrittenInDescription])].filter(
      (noteId) => known.has(noteId),
    );
    noteIds.forEach((noteId) => used.add(noteId));
    return { ...step, description: clean(step.description), noteIds };
  });

  return {
    summary,
    steps,
    noteReferences: availableReferences.filter((reference) => used.has(reference.noteId)),
  };
}

/** A model may say `done`; completion still requires every capability the
 * approved plan promised to have succeeded. `expectedTools` describes kinds
 * of work, not call cardinality: a plan often repeats `read_note` in prose even
 * though one successful read satisfies both later steps. Counting duplicates
 * made efficient, correctly completed runs fail their final audit. */
export function missingSuccessfulPlanTools(
  plan: AgentPlan,
  calls: AgentToolCallRecord[],
): AgentToolName[] {
  const remaining = new Set<AgentToolName>();
  for (const step of plan.steps) {
    for (const tool of step.expectedTools) {
      remaining.add(tool);
    }
  }
  for (const call of calls) {
    if (call.status !== 'succeeded') continue;
    remaining.delete(call.tool);
  }
  return [...remaining];
}

export async function defaultAgentScope(): Promise<AgentScope> {
  const ui = useUiStore.getState();
  if (ui.multiSelection.length) {
    return { kind: 'selection', noteIds: [...ui.multiSelection] };
  }
  if (ui.view.kind === 'course') {
    return { kind: 'course', courseId: ui.view.courseId };
  }
  const note = useEditorStore.getState().note;
  if (note?.courseId) return { kind: 'course', courseId: note.courseId };
  if (note) return { kind: 'selection', noteIds: [note.id] };
  return { kind: 'library' };
}

export async function planAgentCommand(
  input: PlanAgentInput,
  options: AiRunOptions = {},
): Promise<CommandResult<AgentRunRecord>> {
  const instruction = input.instruction.trim();
  if (!instruction) return fail('invalid_input', 'an instruction is required');
  const parsedScope = AgentScopeSchema.safeParse(
    input.scope ?? (await defaultAgentScope()),
  );
  if (!parsedScope.success) {
    return fail('invalid_input', 'invalid agent scope', parsedScope.error.issues);
  }
  const parent = input.followUpTo
    ? useAgentStore.getState().runs.find((run) => run.id === input.followUpTo)
    : undefined;
  if (input.followUpTo && !parent) {
    return fail('not_found', `no agent run ${input.followUpTo}`);
  }
  if (parent?.status === 'planned' || parent?.status === 'running') {
    return fail('conflict', 'finish the current agent run before following up');
  }
  if (parent?.changeset?.state === 'pending') {
    // A follow-up planned over changes that may or may not land would be
    // planned against a library nobody can describe.
    return fail('conflict', i18n.t('agent.changeset.decideFirst'));
  }
  const followUpContext = parent ? contextForFollowUp(parent) : undefined;

  await useEditorStore.getState().flush();
  const lookup = await providerFor('agent');
  if (!lookup.ok) return fail('not_supported', lookup.reason);
  const scopeDescription = await describeScope(parsedScope.data);
  const standingInstructions =
    useSettingsStore.getState().settings.agentInstructions.trim() || undefined;

  try {
    const draft = await requestAgentPlan(
      {
        provider: lookup.provider,
        instruction,
        scope: parsedScope.data,
        scopeContext: scopeDescription.context,
        followUpContext,
        language: language(),
        standingInstructions,
      },
      options,
    );
    const plan = finalizeAgentPlan(draft, scopeDescription.noteReferences);
    if (parsedScope.data.kind !== 'library' && requiredScopeForPlan(plan) === 'library') {
      return fail('scope_denied', i18n.t('agent.scopeRequiredLibrary'), {
        kind: 'scope_required',
        requiredScope: 'library',
      });
    }
    const run: AgentRunRecord = {
      id: `agent_${newId()}`,
      parentRunId: parent?.id,
      instruction,
      scope: parsedScope.data,
      plan,
      budget: input.budget ?? DEFAULT_AGENT_BUDGET,
      status: 'planned',
      calls: [],
      touchedNotes: [],
      undoJournal: {
        notesBefore: [],
        createdNoteIds: [],
        createdCourses: [],
        createdSections: [],
        createdTagIds: [],
        tagsBeforeRename: [],
      },
      tokensUsed: 0,
      startedAt: null,
      completedAt: null,
      standingInstructions,
    };
    useAgentStore.getState().putRun(run);
    useAgentStore.getState().setActiveRun(run.id);
    return ok(run);
  } catch (error) {
    if (error instanceof AiParseError) {
      return fail('invalid_input', i18n.t('agent.invalidModelResponse'));
    }
    return aiFailure(error, options.signal);
  }
}

export async function runAgentCommand(
  runId: string,
  options: AiRunOptions = {},
  /** Evaluation only: run over the JSON decision document even where the
   * provider supports native calls, so the two can be compared on one corpus. */
  evaluation: { forceJson?: boolean } = {},
): Promise<CommandResult<AgentRunRecord>> {
  const stored = useAgentStore.getState().runs.find((run) => run.id === runId);
  if (!stored) return fail('not_found', `no agent run ${runId}`);
  if (stored.status === 'running')
    return fail('conflict', 'the agent run is already running');
  if (stored.status === 'undone')
    return fail('conflict', 'the agent run was already undone');
  if (stored.status !== 'planned')
    return fail('conflict', 'the agent run already finished');

  // Planning flushed the editor, but the agent no longer runs behind a modal:
  // a student can keep typing between reviewing the plan and starting it, and
  // an unflushed keystroke would reach the database *after* the agent read the
  // note it belongs to.
  await useEditorStore.getState().flush();
  const lookup = await providerFor('agent');
  if (!lookup.ok) return fail('not_supported', lookup.reason);
  const record = structuredClone(stored);
  record.status = 'running';
  record.startedAt = new Date().toISOString();
  record.completedAt = null;
  record.error = undefined;
  put(record);
  const scopeDescription = await describeScope(record.scope);
  const parent = record.parentRunId
    ? useAgentStore.getState().runs.find((run) => run.id === record.parentRunId)
    : undefined;

  const toolDefinitions = evaluation.forceJson
    ? undefined
    : agentToolDefinitions(agentToolParameters());
  record.toolMode = usesNativeTools({ provider: lookup.provider, toolDefinitions })
    ? 'native'
    : 'json';
  record.questions = [];
  record.changeset = planStagesChanges(record.plan)
    ? { state: 'staging', calls: [], noteVersions: {} }
    : undefined;
  put(record);

  try {
    const result = await runAgentLoop(
      {
        provider: lookup.provider,
        instruction: record.instruction,
        scope: record.scope,
        scopeContext: scopeDescription.context,
        followUpContext: parent ? contextForFollowUp(parent) : undefined,
        plan: record.plan,
        budget: record.budget,
        language: language(),
        standingInstructions: record.standingInstructions,
        toolDefinitions,
        executeTool: (tool, args, signal) => executeAgentTool(record, tool, args, signal),
        askStudent: (question, signal) => askStudent(record, question, signal),
        onToolStart: ({ callId, decision }) => {
          const call: AgentToolCallRecord = {
            id: callId,
            tool: decision.tool,
            arguments: auditValue(decision.arguments) as Record<string, unknown>,
            rationale: decision.rationale,
            status: 'running',
            startedAt: new Date().toISOString(),
          };
          record.calls.push(call);
          put(record);
        },
        onToolFinish: ({ callId, outcome }) => {
          const call = record.calls.find((entry) => entry.id === callId);
          if (!call || !outcome) return;
          call.status = outcome.ok
            ? 'succeeded'
            : outcome.code === 'cancelled'
              ? 'cancelled'
              : 'failed';
          call.completedAt = new Date().toISOString();
          if (outcome.ok) call.resultPreview = preview(outcome.value);
          else call.error = outcome.message;
          put(record);
        },
        onUsage: ({ tokensUsed }) => {
          record.tokensUsed = tokensUsed;
          put(record);
        },
      },
      options,
    );
    const missingTools = missingSuccessfulPlanTools(record.plan, record.calls);
    if (!result.outcomeAchieved) record.summary = result.summary;
    if (!result.outcomeAchieved || missingTools.length > 0) {
      throw new AgentCompletionError(missingTools);
    }
    await settleChangeset(record, true, options.signal);
    record.status = 'completed';
    record.summary = result.summary;
    record.tokensUsed = result.tokensUsed;
    record.completedAt = new Date().toISOString();
    put(record);
    return ok(record);
  } catch (error) {
    const cancelled = options.signal?.aborted;
    const scopeDenied = error instanceof AgentScopeError;
    // Stopped, timed out or garbled on the turn after the last planned step:
    // the work is in the notes, and "cancelled" alone reads as if it were not.
    // Still not `completed` — the model never gave its verdict.
    const workDone =
      !scopeDenied &&
      !(error instanceof AgentBudgetError) &&
      !(error instanceof AgentCompletionError) &&
      record.calls.some((call) => call.status === 'succeeded') &&
      !record.calls.some((call) => call.status === 'running') &&
      missingSuccessfulPlanTools(record.plan, record.calls).length === 0;
    record.status = cancelled ? 'cancelled' : 'failed';
    record.error = workDone
      ? i18n.t('agent.stoppedAfterWork')
      : error instanceof AgentBudgetError
        ? budgetError(error.limit)
        : error instanceof AgentCompletionError
          ? i18n.t('agent.incompletePlan')
          : error instanceof AiParseError
            ? i18n.t('agent.invalidModelResponse')
            : error instanceof Error
              ? declinedOrigin(error) ?? error.message
              : String(error);
    record.completedAt = new Date().toISOString();
    record.pendingQuestion = undefined;
    pendingAnswers.delete(record.id);
    await settleChangeset(record, false);
    for (const call of record.calls) {
      if (call.status === 'running') {
        call.status = cancelled ? 'cancelled' : 'failed';
        call.completedAt = record.completedAt;
        call.error = record.error;
      }
    }
    put(record);
    return cancelled
      ? fail('cancelled', 'cancelled')
      : scopeDenied
        ? fail('scope_denied', record.error, error.details)
        : fail(
            'invalid_input',
            record.error,
            error instanceof AgentCompletionError
              ? { kind: 'incomplete_plan', missingTools: error.missingTools }
              : undefined,
          );
  }
}

/** The resolver of each run's open question, so the panel can answer it. One
 * per run: the loop asks one question at a time and waits. */
const pendingAnswers = new Map<string, (answer: string) => void>();

/**
 * Put the model's question on the run and wait for the student.
 *
 * The run stays `running` — it is paused on the student, not finished — and
 * the record carries the question so the panel can show it and a reload can
 * tell a waiting run from a working one. Stop rejects the wait through the
 * signal like any other step.
 */
function askStudent(
  record: AgentRunRecord,
  question: AgentQuestion,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = newId();
    record.pendingQuestion = { id, ...question };
    put(record);
    const onAbort = () => {
      pendingAnswers.delete(record.id);
      record.pendingQuestion = undefined;
      put(record);
      reject(signal.reason ?? new DOMException('cancelled', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    pendingAnswers.set(record.id, (answer) => {
      signal.removeEventListener('abort', onAbort);
      pendingAnswers.delete(record.id);
      record.pendingQuestion = undefined;
      record.questions = [...(record.questions ?? []), { ...question, answer }].slice(
        -MAX_AGENT_QUESTIONS,
      );
      put(record);
      resolve(answer);
    });
  });
}

/** The student's answer to the question a running agent asked. */
export function answerAgentQuestionCommand(
  runId: string,
  answer: string,
): CommandResult<void> {
  const text = answer.trim();
  if (!text) return fail('invalid_input', 'an answer is required');
  const resolve = pendingAnswers.get(runId);
  if (!resolve) return fail('not_found', `no question waiting on agent run ${runId}`);
  resolve(text.slice(0, 2_000));
  return ok(undefined);
}

function contextForFollowUp(run: AgentRunRecord): AgentFollowUpContext {
  return {
    instruction: run.instruction,
    planSummary: run.plan.summary,
    resultSummary: run.summary,
    touchedNoteTitles: run.touchedNotes.map((note) => note.title).filter(Boolean),
  };
}

export async function undoAgentRunCommand(
  runId: string,
): Promise<CommandResult<AgentRunRecord>> {
  const stored = useAgentStore.getState().runs.find((run) => run.id === runId);
  if (!stored) return fail('not_found', `no agent run ${runId}`);
  if (stored.status === 'running')
    return fail('conflict', 'stop the agent before undoing');
  if (stored.status === 'undone') return ok(stored);
  const record = structuredClone(stored);
  // Changes still waiting for Apply were never made; undoing the run is also
  // deciding against them.
  if (record.changeset?.state === 'pending') record.changeset.state = 'discarded';

  // Restore pre-existing notes from the exact pre-run snapshot plus the
  // metadata snapshots do not carry. Created notes are archived, never purged.
  for (const touched of [...record.touchedNotes].reverse()) {
    if (touched.created) {
      const note = await library.getNote(touched.noteId);
      if (note && !note.archived) {
        const archived = await updateNoteCommand(
          { noteId: note.id, baseUpdatedAt: note.updatedAt, archived: true },
          { source: 'user', snapshotCause: 'restore' },
        );
        if (!archived.ok) return archived;
      }
      continue;
    }
    const metadata = record.undoJournal.notesBefore.find(
      (entry) => entry.noteId === touched.noteId,
    );
    let current = await library.getNote(touched.noteId);
    if (!current) continue;

    // Trash is recoverable but is not part of a content snapshot. Restore a
    // live pre-run note before applying its snapshot, and put an originally
    // trashed note back only after all metadata/content restoration is done.
    if (metadata?.trashedAt === null && current.trashedAt !== null) {
      const restoredFromTrash = await restoreNotesCommand([current.id]);
      if (!restoredFromTrash.ok) return restoredFromTrash;
      current = (await library.getNote(current.id)) ?? current;
    }

    if (touched.snapshotId) {
      const snapshot = await library.getSnapshot(touched.snapshotId);
      if (snapshot) {
        const restored = await updateNoteCommand(
          {
            noteId: current.id,
            baseUpdatedAt: current.updatedAt,
            title: snapshot.title,
            doc: snapshot.doc,
            courseId: metadata?.courseId,
            sectionId: metadata?.sectionId,
            tagIds: metadata?.tagIds,
            pinned: metadata?.pinned,
            archived: metadata?.archived,
          },
          { source: 'user', snapshotCause: 'restore' },
        );
        if (!restored.ok) return restored;
        current = restored.value;
      }
    }

    if (metadata?.trashedAt && current.trashedAt === null) {
      const returnedToTrash = await trashNotesCommand([current.id]);
      if (!returnedToTrash.ok) return returnedToTrash;
    }
  }

  // Tasks go back whole. `upsertTask` rather than `updateTaskCommand` because
  // the journalled row *is* the answer, including its `updatedAt` — running it
  // through the patching command would stamp a new one and defeat the point.
  for (const task of record.undoJournal.tasksBefore ?? []) {
    await library.upsertTask(task);
  }
  for (const links of record.undoJournal.taskLinksBefore ?? []) {
    await library.setTaskNoteLinks(links.taskId, links.noteIds);
  }
  // Created tasks go to recoverable Trash, never purged — the same rule that
  // archives an agent-created note rather than destroying it.
  const createdTaskIds = record.undoJournal.createdTaskIds ?? [];
  if (createdTaskIds.length) {
    const live = [];
    for (const taskId of createdTaskIds) {
      const task = await library.getTask(taskId);
      if (task && !task.trashedAt) live.push(taskId);
    }
    if (live.length) await library.trashTasks(live);
  }
  if (createdTaskIds.length || (record.undoJournal.tasksBefore ?? []).length) {
    await useLibraryStore.getState().refreshTasks();
  }

  for (const tag of record.undoJournal.tagsBeforeRename) {
    const restored = await updateTagCommand(tag);
    if (!restored.ok) return restored;
  }
  for (const tagId of [...record.undoJournal.createdTagIds].reverse()) {
    if (await hasExternalNotes({ tagIds: [tagId] }, record.undoJournal.createdNoteIds)) {
      continue;
    }
    const removed = await deleteTagCommand(tagId);
    if (!removed.ok) return removed;
  }
  for (const section of [...record.undoJournal.createdSections].reverse()) {
    if (
      await hasExternalNotes({ sectionId: section.id }, record.undoJournal.createdNoteIds)
    ) {
      continue;
    }
    const removed = await deleteSectionCommand(section);
    if (!removed.ok) return removed;
  }
  for (const course of [...record.undoJournal.createdCourses].reverse()) {
    const [hasNotes, remainingSections] = await Promise.all([
      hasExternalNotes({ courseId: course.id }, record.undoJournal.createdNoteIds),
      library.listSections(course.id),
    ]);
    if (hasNotes || remainingSections.length > 0) continue;
    const removed = await deleteCourseCommand(course.id);
    if (!removed.ok) return removed;
  }

  record.status = 'undone';
  record.completedAt = new Date().toISOString();
  put(record);
  await useLibraryStore.getState().refreshCurrentView();
  return ok(record);
}

/** Shared-run executor exported for contract tests and future non-dialog
 * surfaces. It still delegates every capability to the MCP handler table. */
export async function executeAgentTool(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentToolOutcome> {
  const scoped = await enforceScope(record, tool, args);
  if (!scoped.ok) return scoped;
  if (record.changeset?.state === 'staging' && STAGEABLE_TOOLS.has(tool)) {
    return stageTool(record, tool, scoped.value, signal);
  }
  return performTool(record, tool, scoped.value, signal);
}

/** Told to the model in place of a staged call's result. */
const STAGED_NOTE =
  'Recorded for the student to review. It is applied when they approve this run’s changes, after you finish: treat it as done, do not repeat it, and do not expect reads to show it yet.';

/**
 * Record a metadata write instead of making it (plan §3.2 item 8).
 *
 * The versions are checked now, as the handler would, so a stale read fails
 * while the model can still recover — not at Apply, after it has finished.
 */
async function stageTool(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentToolOutcome> {
  const changeset = record.changeset!;
  const split = splitForStaging(tool, args);
  let now: AgentToolOutcome | null = null;
  if (split.now) {
    now = await performTool(record, tool, split.now, signal);
    if (!now.ok || !split.staged) return now;
  }
  const staged = split.staged!;
  const call = { id: newId(), tool, arguments: staged };
  const refs = stagedRefs(call);
  if (new Set(refs.map((ref) => ref.noteId)).size !== refs.length) {
    return fail('invalid_input', 'each note may appear only once');
  }
  for (const ref of refs) {
    const note = await library.getNote(ref.noteId);
    if (!note) return fail('not_found', `no note ${ref.noteId}`);
    if (note.updatedAt !== ref.baseUpdatedAt) {
      return fail('conflict', 'the note changed after it was read', {
        noteId: note.id,
        expectedUpdatedAt: ref.baseUpdatedAt,
        actualUpdatedAt: note.updatedAt,
      });
    }
    if (note.trashedAt !== null) {
      return fail('invalid_input', 'a note is already in Trash', { noteId: note.id });
    }
  }
  if (changeset.calls.length >= MAX_STAGED_CALLS) {
    return fail('invalid_input', 'too many changes are waiting for review in this run');
  }
  changeset.calls.push(call);
  put(record);
  return ok({
    staged: true,
    notes: refs.length,
    ...(now?.ok ? { created: now.value } : {}),
    note: STAGED_NOTE,
  });
}

const MAX_STAGED_CALLS = 500;

/**
 * Decide a run's staged changes as it ends: a small changeset that finished
 * cleanly is applied now; a large one, or one a run left unfinished, waits for
 * the student.
 */
async function settleChangeset(
  record: AgentRunRecord,
  completed: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const changeset = record.changeset;
  if (!changeset || changeset.state !== 'staging') return;
  if (!changeset.calls.length) {
    record.changeset = undefined;
    return;
  }
  changeset.state = 'pending';
  if (completed && changesetNoteIds(changeset.calls).length <= CHANGESET_REVIEW_THRESHOLD) {
    await applyChangeset(record, signal);
  }
  put(record);
}

/**
 * Make a changeset's writes, through the same executor and journal as any
 * other call — so they are in whole-run undo like the rest of the run.
 *
 * Each note must still be at the version the run left it; one the student
 * edited since is skipped and reported, never overwritten. Scope is checked
 * again, because a note can leave a course between staging and Apply.
 */
async function applyChangeset(record: AgentRunRecord, signal?: AbortSignal): Promise<void> {
  const changeset = record.changeset!;
  const skipped = new Map<string, string>();
  const controller = signal ? null : new AbortController();
  const live = signal ?? controller!.signal;

  for (const staged of changeset.calls) {
    // A copy: versions are refreshed in place below, and the recorded call
    // must keep saying what the run staged.
    const call = { tool: staged.tool, arguments: structuredClone(staged.arguments) };
    const refs = stagedRefs(call);
    const drop = new Set<string>();
    const current = new Map<string, string>();
    for (const ref of refs) {
      const note = await library.getNote(ref.noteId);
      const unchanged =
        note &&
        note.trashedAt === null &&
        (note.updatedAt === ref.baseUpdatedAt ||
          note.updatedAt === changeset.noteVersions[ref.noteId]);
      if (!unchanged) {
        drop.add(ref.noteId);
        skipped.set(ref.noteId, note?.title ?? '');
      } else current.set(ref.noteId, note.updatedAt);
    }
    const args = withoutNotes(call, drop);
    for (const ref of stagedRefs({ tool: call.tool, arguments: args })) {
      ref.baseUpdatedAt = current.get(ref.noteId)!;
    }
    if (!stagedRefs({ tool: call.tool, arguments: args }).length) continue;

    const scoped = await enforceScope(record, call.tool, args);
    const outcome = scoped.ok
      ? await performTool(record, call.tool, scoped.value, live)
      : scoped;
    if (!outcome.ok) {
      for (const noteId of current.keys()) {
        const note = await library.getNote(noteId);
        skipped.set(noteId, note?.title ?? '');
      }
    }
  }
  changeset.state = 'applied';
  changeset.skipped = [...skipped].map(([noteId, title]) => ({ noteId, title }));
  put(record);
  await useLibraryStore.getState().refreshCurrentView();
  await useLibraryStore.getState().refreshTags();
}

/** Apply a run's pending changeset — the student's Apply. */
export async function applyAgentChangesetCommand(
  runId: string,
): Promise<CommandResult<AgentRunRecord>> {
  const stored = useAgentStore.getState().runs.find((run) => run.id === runId);
  if (!stored) return fail('not_found', `no agent run ${runId}`);
  if (stored.status === 'running') return fail('conflict', 'the agent run is still running');
  if (stored.changeset?.state !== 'pending') {
    return fail('conflict', 'this run has no changes waiting for review');
  }
  await useEditorStore.getState().flush();
  const record = structuredClone(stored);
  await applyChangeset(record);
  return ok(record);
}

/** Drop a run's pending changeset — the student's Cancel. Nothing was
 * written, so there is nothing to put back. */
export function discardAgentChangesetCommand(runId: string): CommandResult<AgentRunRecord> {
  const stored = useAgentStore.getState().runs.find((run) => run.id === runId);
  if (!stored) return fail('not_found', `no agent run ${runId}`);
  if (stored.changeset?.state !== 'pending') {
    return fail('conflict', 'this run has no changes waiting for review');
  }
  const record = structuredClone(stored);
  record.changeset!.state = 'discarded';
  put(record);
  return ok(record);
}

/** Run one tool for real: the ceiling check, the before-image, the handler,
 * and the journal entry that makes it undoable. */
async function performTool(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentToolOutcome> {
  const affordable = await modelCallFits(record, tool, args);
  if (!affordable) {
    return { ok: false, code: BUDGET_EXHAUSTED, message: budgetError('tokens') };
  }
  const before = await captureBefore(record, tool, args);
  let result: AgentToolOutcome | undefined;
  let modelTokens = 0;
  try {
    const handled = await executeToolHandler(tool, args, {
      source: 'agent',
      agentName: 'NotaBene in-app agent',
      agentRunId: record.id,
      signal,
      onModelUsage: (tokens) => {
        modelTokens += tokens;
      },
    });
    result = handled.ok
      ? {
          ok: true,
          value: await filterReadResult(record.scope, tool, handled.value),
        }
      : handled;
    if (modelTokens) result = { ...result, modelTokens };
    return result;
  } finally {
    // A handler can be cancelled or fail after an earlier step already wrote
    // (for example, creating a tag before updating its note). Journal the
    // observed delta even on that path so whole-run undo remains whole.
    await journalAfter(
      record,
      tool,
      args,
      result?.ok ? result.value : undefined,
      before,
    );
    if (record.changeset && result?.ok) await recordVersions(record, tool, args, result.value);
    put(record);
  }
}

/** Remember the version each note is at after the run's own write, so a
 * staged change to it still applies once the run has moved it on. */
async function recordVersions(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
  value: unknown,
): Promise<void> {
  const noteIds = writeNoteIds(tool, args);
  if (isNote(value)) noteIds.push(value.id);
  for (const noteId of noteIds) {
    const note = await library.getNote(noteId);
    if (note) record.changeset!.noteVersions[noteId] = note.updatedAt;
  }
}

/** Tools that make a model call of their own (plan §3.2 item 7). */
const MODEL_TOOLS = new Set<AgentToolName>([
  'define',
  'generate_flashcards',
  'synthesize_notes',
  'visualize_note',
]);

/** Room kept for what a study feature writes back, on top of what it sends. */
const MODEL_TOOL_OUTPUT_ALLOWANCE = 8_192;

/**
 * Whether a study feature's model call fits in what is left of the ceiling.
 *
 * Checked before the call rather than after it, because a synthesis of ten
 * notes can cost more than every turn of the run so far, and the ceiling was
 * shown to the student as a promise.
 */
async function modelCallFits(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (!MODEL_TOOLS.has(tool)) return true;
  let input = typeof args.context === 'string' ? estimateTokens(args.context) : 0;
  for (const noteId of modelSourceNoteIds(tool, args)) {
    const note = await library.getNote(noteId);
    if (note) input += estimateTokens(note.plainText);
  }
  return (
    record.tokensUsed + input + MODEL_TOOL_OUTPUT_ALLOWANCE <= record.budget.tokenCeiling
  );
}

function modelSourceNoteIds(tool: AgentToolName, args: Record<string, unknown>): string[] {
  if (tool === 'visualize_note') {
    return typeof args.noteId === 'string' ? [args.noteId] : [];
  }
  if (tool === 'generate_flashcards' || tool === 'synthesize_notes') {
    return stringArray(args.noteIds);
  }
  return [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

interface BeforeTool {
  tags: Tag[];
  courses: Course[];
  sections: Section[];
}

async function captureBefore(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
): Promise<BeforeTool> {
  for (const noteId of writeNoteIds(tool, args)) {
    if (
      record.undoJournal.createdNoteIds.includes(noteId) ||
      record.undoJournal.notesBefore.some((entry) => entry.noteId === noteId)
    ) {
      continue;
    }
    const note = await library.getNote(noteId);
    if (note) {
      record.undoJournal.notesBefore.push({
        noteId: note.id,
        courseId: note.courseId,
        sectionId: note.sectionId,
        tagIds: [...note.tagIds],
        pinned: note.pinned,
        archived: note.archived,
        trashedAt: note.trashedAt,
      });
    }
  }
  const tags = TAG_CREATING_TOOLS.has(tool) ? await library.listTags() : [];
  const courses = tool === 'create_course' ? await library.listCourses() : [];
  const sectionCourseId =
    tool === 'organize' && isObject(args.createSection)
      ? args.createSection.courseId
      : undefined;
  const sections =
    typeof sectionCourseId === 'string'
      ? await library.listSections(sectionCourseId)
      : [];

  // Tasks are journalled whole rather than field by field: a task is small, and
  // "put it back exactly as it was" is the only undo worth offering for one.
  const taskId = referencedTaskId(tool, args);
  if (taskId !== null) {
    const journal = record.undoJournal;
    journal.tasksBefore ??= [];
    journal.createdTaskIds ??= [];
    journal.taskLinksBefore ??= [];
    if (
      !journal.createdTaskIds.includes(taskId) &&
      !journal.tasksBefore.some((entry) => entry.id === taskId)
    ) {
      const task = await library.getTask(taskId);
      if (task) journal.tasksBefore.push(task);
    }
    if (
      tool === 'link_task_note' &&
      !journal.taskLinksBefore.some((entry) => entry.taskId === taskId)
    ) {
      const links = await library.listTaskNoteLinks();
      journal.taskLinksBefore.push({
        taskId,
        noteIds: links
          .filter((link) => link.taskId === taskId && link.origin === 'manual')
          .map((link) => link.noteId),
      });
    }
  }

  return { tags, courses, sections };
}

async function journalAfter(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
  value: unknown,
  before: BeforeTool,
): Promise<void> {
  if (tool === 'create_task' && isObject(value) && typeof value.id === 'string') {
    record.undoJournal.createdTaskIds ??= [];
    addUnique(record.undoJournal.createdTaskIds, value.id);
  }
  if (
    (tool === 'create_note' || tool === 'merge_notes' || tool === 'synthesize_notes') &&
    isNote(value)
  ) {
    addUnique(record.undoJournal.createdNoteIds, value.id);
    upsertTouched(record, value.id, value.title, null, true);
  }
  if (tool === 'create_course') {
    const beforeIds = new Set(before.courses.map((course) => course.id));
    for (const course of await library.listCourses()) {
      if (
        !beforeIds.has(course.id) &&
        !record.undoJournal.createdCourses.some((entry) => entry.id === course.id)
      ) {
        record.undoJournal.createdCourses.push(course);
      }
    }
  }
  if (tool === 'organize' && isObject(args.createSection)) {
    const courseId = args.createSection.courseId;
    if (typeof courseId === 'string') {
      const beforeIds = new Set(before.sections.map((section) => section.id));
      for (const section of await library.listSections(courseId)) {
        if (
          !beforeIds.has(section.id) &&
          !record.undoJournal.createdSections.some((entry) => entry.id === section.id)
        ) {
          record.undoJournal.createdSections.push(section);
        }
      }
    }
  }
  if (TAG_CREATING_TOOLS.has(tool)) {
    const after = await library.listTags();
    const beforeById = new Map(before.tags.map((tag) => [tag.id, tag]));
    for (const tag of after) {
      const previous = beforeById.get(tag.id);
      if (!previous) addUnique(record.undoJournal.createdTagIds, tag.id);
      else if (
        !record.undoJournal.createdTagIds.includes(tag.id) &&
        (previous.name !== tag.name || previous.namespace !== tag.namespace) &&
        !record.undoJournal.tagsBeforeRename.some((entry) => entry.id === tag.id)
      ) {
        record.undoJournal.tagsBeforeRename.push(previous);
      }
    }
  }

  for (const noteId of writeNoteIds(tool, args)) {
    const note = await library.getNote(noteId);
    if (!note) continue;
    const snapshots = await library.listSnapshots(noteId);
    const firstInRun = snapshots
      .filter((snapshot) => snapshot.runId === record.id)
      .at(-1);
    upsertTouched(record, note.id, note.title, firstInRun?.id ?? null, false);
  }
}

/** Tools that may create a tag as a side effect, so the tag list is compared
 * before and after them. Synthesis files its note under `type:summary`. */
const TAG_CREATING_TOOLS = new Set<AgentToolName>([
  'manage_tags',
  'create_note',
  'synthesize_notes',
]);

async function enforceScope(
  record: AgentRunRecord,
  tool: AgentToolName,
  args: Record<string, unknown>,
): Promise<CommandResult<Record<string, unknown>>> {
  const scoped = { ...args };
  if (record.scope.kind === 'course' && tool === 'list_notes') {
    scoped.courseId = record.scope.courseId;
  }
  if (record.scope.kind === 'course' && tool === 'create_note') {
    scoped.courseId = record.scope.courseId;
  }
  if (
    record.scope.kind === 'course' &&
    (tool === 'list_tasks' || tool === 'create_task')
  ) {
    scoped.courseId = record.scope.courseId;
  }
  if (record.scope.kind === 'course' && tool === 'create_course') {
    return scopeDenied();
  }
  if (record.scope.kind === 'selection' && tool === 'create_course') {
    return scopeDenied();
  }
  if (
    record.scope.kind !== 'library' &&
    tool === 'manage_tags' &&
    Array.isArray(scoped.rename) &&
    scoped.rename.length > 0
  ) {
    return scopeDenied();
  }

  const ids = referencedNoteIds(tool, scoped);
  for (const noteId of ids) {
    if (!(await noteAllowed(record, noteId))) {
      return scopeDenied();
    }
  }
  if (record.scope.kind === 'course' && tool === 'update_note') {
    const target = scoped.courseId;
    if (target !== undefined && target !== record.scope.courseId) {
      return scopeDenied();
    }
  }
  const taskId = referencedTaskId(tool, scoped);
  if (taskId !== null && !(await taskAllowed(record, taskId))) {
    return scopeDenied();
  }
  // Moving a task out of the scoped course would put it somewhere the run can
  // no longer see, which is a widening dressed up as an edit.
  if (record.scope.kind === 'course' && tool === 'update_task') {
    const target = scoped.courseId;
    if (target !== undefined && target !== record.scope.courseId) {
      return scopeDenied();
    }
  }
  if (record.scope.kind === 'course' && tool === 'organize') {
    const scopeCourseId = record.scope.courseId;
    const section = isObject(scoped.createSection) ? scoped.createSection : null;
    if (section && section.courseId !== scopeCourseId) {
      return scopeDenied();
    }
    const moves = Array.isArray(scoped.moves) ? scoped.moves : [];
    if (
      moves.some(
        (move) =>
          isObject(move) &&
          move.courseId !== undefined &&
          move.courseId !== scopeCourseId,
      )
    ) {
      return scopeDenied();
    }
  }
  return ok(scoped);
}

function scopeDenied(): CommandResult<Record<string, unknown>> {
  return fail('scope_denied', i18n.t('agent.scopeDeniedLibrary'), {
    kind: 'scope_denied',
    requiredScope: 'library',
  });
}

async function filterReadResult(
  scope: AgentScope,
  tool: AgentToolName,
  value: unknown,
): Promise<unknown> {
  if (tool === 'list_tasks' && Array.isArray(value)) {
    if (scope.kind === 'library') return value;
    if (scope.kind === 'course') {
      return value.filter(
        (entry) => isObject(entry) && entry.courseId === scope.courseId,
      );
    }
    const links = await library.listTaskNoteLinks();
    const reachable = new Set(
      links
        .filter((link) => scope.noteIds.includes(link.noteId))
        .map((link) => link.taskId),
    );
    return value.filter(
      (entry) =>
        isObject(entry) && typeof entry.id === 'string' && reachable.has(entry.id),
    );
  }
  if ((tool !== 'list_notes' && tool !== 'search_notes') || !Array.isArray(value)) {
    return value;
  }
  const filtered = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.id !== 'string') continue;
    if (scope.kind === 'library') filtered.push(entry);
    else if (scope.kind === 'selection' && scope.noteIds.includes(entry.id)) {
      filtered.push(entry);
    } else if (scope.kind === 'course' && entry.courseId === scope.courseId) {
      filtered.push(entry);
    }
  }
  return filtered;
}

async function noteAllowed(record: AgentRunRecord, noteId: string): Promise<boolean> {
  if (record.undoJournal.createdNoteIds.includes(noteId)) return true;
  if (record.scope.kind === 'library') return true;
  if (record.scope.kind === 'selection') return record.scope.noteIds.includes(noteId);
  const note = await library.getNote(noteId);
  return note?.courseId === record.scope.courseId;
}

function referencedNoteIds(tool: AgentToolName, args: Record<string, unknown>): string[] {
  if (tool === 'manage_tags') {
    // One note or a list of them, and a call may not smuggle a note past the
    // scope check by using the form the other branch reads.
    return [
      ...(typeof args.noteId === 'string' ? [args.noteId] : []),
      ...versionedNoteIds(args),
    ];
  }
  if (
    tool === 'read_note' ||
    tool === 'update_note' ||
    tool === 'list_annotations' ||
    tool === 'read_attachment' ||
    tool === 'list_versions' ||
    tool === 'read_version' ||
    tool === 'visualize_note'
  ) {
    return typeof args.noteId === 'string' ? [args.noteId] : [];
  }
  if (tool === 'synthesize_notes') return stringArray(args.noteIds);
  if (tool === 'generate_flashcards') {
    return [...stringArray(args.noteIds), ...flashcardTarget(args)];
  }
  if (tool === 'export_notes') {
    return Array.isArray(args.noteIds)
      ? args.noteIds.filter((id): id is string => typeof id === 'string')
      : [];
  }
  if (tool === 'organize') {
    return Array.isArray(args.moves)
      ? args.moves
          .map((move) => (isObject(move) ? move.noteId : undefined))
          .filter((id): id is string => typeof id === 'string')
      : [];
  }
  if (
    tool === 'merge_notes' ||
    tool === 'trash_notes' ||
    tool === 'restore_notes' ||
    tool === 'archive_notes'
  ) {
    return versionedNoteIds(args);
  }
  if (tool === 'link_task_note' || tool === 'list_tasks') {
    return typeof args.noteId === 'string' ? [args.noteId] : [];
  }
  if (tool === 'create_task') {
    return Array.isArray(args.noteIds)
      ? args.noteIds.filter((id): id is string => typeof id === 'string')
      : [];
  }
  if (tool === 'create_note' && isObject(args.copyFrom)) {
    return typeof args.copyFrom.noteId === 'string' ? [args.copyFrom.noteId] : [];
  }
  return [];
}

/** The task a tool call is aimed at, where it names exactly one. */
function referencedTaskId(
  tool: AgentToolName,
  args: Record<string, unknown>,
): string | null {
  if (tool === 'update_task' || tool === 'complete_task' || tool === 'link_task_note') {
    return typeof args.taskId === 'string' ? args.taskId : null;
  }
  return null;
}

/**
 * May this run touch this task?
 *
 * Course scope means the course's tasks. Selection scope means tasks linked to
 * the notes in the selection — the only reading of "this selection" that gives
 * a task-aware agent anything to do, and it still cannot reach a task belonging
 * to a note the student did not choose.
 */
async function taskAllowed(record: AgentRunRecord, taskId: string): Promise<boolean> {
  if (record.undoJournal.createdTaskIds?.includes(taskId)) return true;
  if (record.scope.kind === 'library') return true;
  const task = await library.getTask(taskId);
  if (!task) return true; // Let the command report `not_found` rather than a denial.
  if (record.scope.kind === 'course') return task.courseId === record.scope.courseId;
  const links = await library.listTaskNoteLinks();
  return links.some(
    (link) =>
      link.taskId === taskId &&
      record.scope.kind === 'selection' &&
      record.scope.noteIds.includes(link.noteId),
  );
}

/** The note a deck is appended to. Its sources are only read. */
function flashcardTarget(args: Record<string, unknown>): string[] {
  return isObject(args.target) && typeof args.target.noteId === 'string'
    ? [args.target.noteId]
    : [];
}

function writeNoteIds(tool: AgentToolName, args: Record<string, unknown>): string[] {
  if (tool === 'generate_flashcards') return flashcardTarget(args);
  if (
    tool === 'merge_notes' &&
    (args.sourceFate === undefined || args.sourceFate === 'keep')
  ) {
    return [];
  }
  return [
    'update_note',
    'manage_tags',
    'organize',
    'merge_notes',
    'trash_notes',
    'restore_notes',
    'archive_notes',
    'visualize_note',
  ].includes(tool)
    ? referencedNoteIds(tool, args)
    : [];
}

function versionedNoteIds(args: Record<string, unknown>): string[] {
  return Array.isArray(args.notes)
    ? args.notes
        .map((note) => (isObject(note) ? note.noteId : undefined))
        .filter((id): id is string => typeof id === 'string')
    : [];
}

interface ScopeDescription {
  context: string;
  noteReferences: AgentPlan['noteReferences'];
}

async function describeScope(scope: AgentScope): Promise<ScopeDescription> {
  const vocabulary = await libraryVocabulary(scope);
  if (scope.kind === 'selection') {
    const notes = await Promise.all(scope.noteIds.map((id) => library.getNote(id)));
    const present = notes.filter((note): note is Note => note !== null);
    return {
      context: `${present
        .map(
          (note) =>
            `${note.id} — ${note.title || 'Untitled'} — updated ${note.updatedAt}`,
        )
        .join('\n')}\n\n${vocabulary}`,
      noteReferences: present.map(noteReference),
    };
  }
  const query =
    scope.kind === 'course'
      ? { scope: 'live' as const, courseId: scope.courseId, sort: 'updated' as const }
      : { scope: 'live' as const, sort: 'updated' as const };
  const [count, recent] = await Promise.all([
    library.countNotes(query),
    library.queryNotes({ ...query, limit: 30 }),
  ]);
  const label = scope.kind === 'course' ? `Course ${scope.courseId}` : 'Whole library';
  return {
    context: `${label}: ${count} live notes. Recent notes:\n${recent
      .map(
        (note) => `${note.id} — ${note.title || 'Untitled'} — updated ${note.updatedAt}`,
      )
      .join('\n')}\n\n${vocabulary}`,
    noteReferences: recent.map(noteReference),
  };
}

/**
 * The destinations a plan is allowed to name, given to the planner rather than
 * fetched by the run.
 *
 * Courses, sections and tags are a few hundred bytes and almost every run began
 * by spending two of its tool calls asking for them. Naming them up front also
 * stops a plan from inventing a course that does not exist, or a second
 * `topic:revision` beside the one already in the taxonomy.
 */
async function libraryVocabulary(scope: AgentScope): Promise<string> {
  const allCourses = await library.listCourses();
  const courses =
    scope.kind === 'course'
      ? allCourses.filter((course) => course.id === scope.courseId)
      : allCourses;
  const lines = await Promise.all(
    courses.map(async (course) => {
      const sections = await library.listSections(course.id);
      const named = sections
        .map((section) => `${section.name} [${section.id}]`)
        .join(', ');
      return `- ${course.name} [${course.id}]${named ? ` — sections: ${named}` : ''}`;
    }),
  );
  const tags = await library.listTags();
  const shown = tags
    .slice(0, MAX_VOCABULARY_TAGS)
    .map((tag) => `${tag.namespace ? `${tag.namespace}:` : ''}${tag.name} [${tag.id}]`)
    .join(', ');
  const more = tags.length - Math.min(tags.length, MAX_VOCABULARY_TAGS);
  return [
    `Courses and sections:\n${lines.join('\n') || '- none'}`,
    `Existing tags${more > 0 ? ` (${more} more not listed)` : ''}: ${shown || 'none'}`,
  ].join('\n');
}

/** Enough of the taxonomy to reuse rather than duplicate, without turning the
 * planning prompt into a tag dump. */
const MAX_VOCABULARY_TAGS = 60;

function noteReference(
  note: Pick<Note, 'id' | 'title'>,
): AgentPlan['noteReferences'][number] {
  return { noteId: note.id, title: note.title || 'Untitled' };
}

function upsertTouched(
  record: AgentRunRecord,
  noteId: string,
  title: string,
  snapshotId: string | null,
  created: boolean,
): void {
  const existing = record.touchedNotes.find((entry) => entry.noteId === noteId);
  if (existing) {
    existing.title = title;
    existing.created ||= created;
    existing.snapshotId ??= snapshotId;
    return;
  }
  record.touchedNotes.push({ noteId, title, snapshotId, created });
}

function put(record: AgentRunRecord): void {
  useAgentStore.getState().putRun(structuredClone(record));
}

function preview(value: unknown): string {
  const audited = auditValue(value);
  const text = typeof audited === 'string' ? audited : JSON.stringify(audited);
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

/** Run journals are an audit index, not another note store. Keep ids, titles,
 * locations and concurrency tokens while leaving note bodies in snapshots. */
function auditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(auditValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      ['doc', 'markdown', 'plainText'].includes(key)
        ? '[content omitted]'
        : auditValue(entry),
    ]),
  );
}

/** The student's "don't allow" in the transport's dialog, in their words. */
function declinedOrigin(error: Error): string | null {
  if (!error.message.includes('origin_declined:')) return null;
  const failure = aiFailure(error);
  return failure.ok ? null : failure.message;
}

function budgetError(limit: AgentBudgetError['limit']): string {
  return limit === 'tokens'
    ? i18n.t('agent.tokenLimitReached')
    : limit === 'tools'
      ? i18n.t('agent.stepLimitReached')
      : i18n.t('agent.timeLimitReached');
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

/** Preserve work another writer added to a run-created container while the
 * agent was active. Agent-created notes do not count: undo archives them and
 * the database can detach those archived rows when their container goes. */
async function hasExternalNotes(
  filter: { courseId?: string; sectionId?: string; tagIds?: string[] },
  createdNoteIds: string[],
): Promise<boolean> {
  const notes = await library.queryNotes({
    ...filter,
    scope: 'all',
    sort: 'updated',
    limit: createdNoteIds.length + 1,
  });
  return notes.some((note) => !createdNoteIds.includes(note.id));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNote(value: unknown): value is Note {
  return isObject(value) && typeof value.id === 'string' && 'doc' in value;
}
