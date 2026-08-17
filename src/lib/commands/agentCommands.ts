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
  DEFAULT_AGENT_BUDGET,
  requestAgentPlan,
  runAgentLoop,
  type AgentFollowUpContext,
  type AiRunOptions,
  type AgentToolOutcome,
} from '@/lib/ai';
import { executeToolHandler } from '@/lib/mcp/toolHandlers';
import {
  AgentScopeSchema,
  newId,
  type AgentBudget,
  type AgentPlan,
  type AgentPlanDraft,
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
  const followUpContext = parent ? contextForFollowUp(parent) : undefined;

  await useEditorStore.getState().flush();
  const lookup = await providerFor('agent');
  if (!lookup.ok) return fail('not_supported', lookup.reason);
  const scopeDescription = await describeScope(parsedScope.data);

  try {
    const draft = await requestAgentPlan(
      {
        provider: lookup.provider,
        instruction,
        scope: parsedScope.data,
        scopeContext: scopeDescription.context,
        followUpContext,
        language: language(),
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
        executeTool: (tool, args, signal) => executeAgentTool(record, tool, args, signal),
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
    record.status = 'completed';
    record.summary = result.summary;
    record.tokensUsed = result.tokensUsed;
    record.completedAt = new Date().toISOString();
    put(record);
    return ok(record);
  } catch (error) {
    const cancelled = options.signal?.aborted;
    const scopeDenied = error instanceof AgentScopeError;
    record.status = cancelled ? 'cancelled' : 'failed';
    record.error =
      error instanceof AgentBudgetError
        ? budgetError(error.limit)
        : error instanceof AgentCompletionError
          ? i18n.t('agent.incompletePlan')
          : error instanceof AiParseError
            ? i18n.t('agent.invalidModelResponse')
            : error instanceof Error
              ? error.message
              : String(error);
    record.completedAt = new Date().toISOString();
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
  const before = await captureBefore(record, tool, scoped.value);
  let result: AgentToolOutcome | undefined;
  try {
    const handled = await executeToolHandler(tool, scoped.value, {
      source: 'agent',
      agentName: 'NotaBene in-app agent',
      agentRunId: record.id,
      signal,
    });
    result = handled.ok
      ? {
          ok: true,
          value: await filterReadResult(record.scope, tool, handled.value),
        }
      : handled;
    return result;
  } finally {
    // A handler can be cancelled or fail after an earlier step already wrote
    // (for example, creating a tag before updating its note). Journal the
    // observed delta even on that path so whole-run undo remains whole.
    await journalAfter(
      record,
      tool,
      scoped.value,
      result?.ok ? result.value : undefined,
      before,
    );
    put(record);
  }
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
  const tags =
    tool === 'manage_tags' || tool === 'create_note' ? await library.listTags() : [];
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
  if ((tool === 'create_note' || tool === 'merge_notes') && isNote(value)) {
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
  if (tool === 'manage_tags' || tool === 'create_note') {
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
  if (tool === 'read_note' || tool === 'update_note' || tool === 'manage_tags') {
    return typeof args.noteId === 'string' ? [args.noteId] : [];
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
  if (tool === 'merge_notes' || tool === 'trash_notes' || tool === 'restore_notes') {
    return Array.isArray(args.notes)
      ? args.notes
          .map((note) => (isObject(note) ? note.noteId : undefined))
          .filter((id): id is string => typeof id === 'string')
      : [];
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

function writeNoteIds(tool: AgentToolName, args: Record<string, unknown>): string[] {
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
  ].includes(tool)
    ? referencedNoteIds(tool, args)
    : [];
}

interface ScopeDescription {
  context: string;
  noteReferences: AgentPlan['noteReferences'];
}

async function describeScope(scope: AgentScope): Promise<ScopeDescription> {
  if (scope.kind === 'selection') {
    const notes = await Promise.all(scope.noteIds.map((id) => library.getNote(id)));
    const present = notes.filter((note): note is Note => note !== null);
    return {
      context: present
        .map(
          (note) =>
            `${note.id} — ${note.title || 'Untitled'} — updated ${note.updatedAt}`,
        )
        .join('\n'),
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
      .join('\n')}`,
    noteReferences: recent.map(noteReference),
  };
}

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
