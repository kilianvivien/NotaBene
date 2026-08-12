import { beforeEach, describe, expect, it } from 'vitest';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import {
  AgentRunRecordSchema,
  emptyDoc,
  type AgentRunRecord,
  type AgentScope,
} from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { createNoteCommand, updateNoteCommand } from './noteCommands';
import {
  executeAgentTool,
  finalizeAgentPlan,
  missingSuccessfulPlanTools,
  requiredScopeForPlan,
  undoAgentRunCommand,
} from './agentCommands';

function run(scope: AgentScope): AgentRunRecord {
  return {
    id: `agent-test-${Math.random()}`,
    instruction: 'Test the agent command boundary.',
    scope,
    plan: {
      summary: 'Test plan',
      noteReferences: [],
      steps: [
        { description: 'Use a public tool', expectedTools: ['read_note'], noteIds: [] },
      ],
    },
    budget: { tokenCeiling: 10_000, toolCallCeiling: 4, wallClockMs: 10_000 },
    status: 'running',
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
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  localStorage.clear();
  useAgentStore.setState({ runs: [], activeRunId: null });
});

describe('agent command boundary', () => {
  it('loads run journals written before structured note references existed', () => {
    const legacy = run({ kind: 'library' });
    const parsed = AgentRunRecordSchema.parse({
      ...legacy,
      plan: {
        summary: 'Legacy plan',
        steps: [{ description: 'Inspect', expectedTools: ['list_notes'] }],
      },
    });
    expect(parsed.plan).toMatchObject({
      noteReferences: [],
      steps: [{ noteIds: [] }],
    });
  });

  it('keeps note ids structured and replaces them with trusted titles in prose', () => {
    const noteId = 'MjBv0HBQ0PLp';
    const plan = finalizeAgentPlan(
      {
        summary: `Move ${noteId}`,
        steps: [
          {
            description: `Read note ${noteId}`,
            expectedTools: ['read_note'],
            noteIds: [noteId],
          },
        ],
      },
      [{ noteId, title: 'Synthèse : Canicule' }],
    );

    expect(JSON.stringify([plan.summary, plan.steps[0]?.description])).not.toContain(
      noteId,
    );
    expect(plan).toMatchObject({
      summary: 'Move Synthèse : Canicule',
      noteReferences: [{ noteId, title: 'Synthèse : Canicule' }],
      steps: [{ noteIds: [noteId] }],
    });
  });

  it('requires library scope before reviewing a plan that creates a course', () => {
    const record = run({ kind: 'selection', noteIds: ['note-1'] });
    record.plan.steps[0] = {
      description: 'Create Environment',
      expectedTools: ['create_course'],
      noteIds: [],
    };
    expect(requiredScopeForPlan(record.plan)).toBe('library');
  });

  it('does not consider a plan complete until every promised tool succeeded', () => {
    const record = run({ kind: 'library' });
    record.plan.steps = [
      {
        description: 'Create and file',
        expectedTools: ['create_course', 'organize'],
        noteIds: [],
      },
    ];
    record.calls = [
      {
        id: 'failed-course',
        tool: 'create_course',
        arguments: { name: 'Environment' },
        rationale: 'Create it.',
        status: 'failed',
        error: 'denied',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'filed',
        tool: 'organize',
        arguments: {},
        rationale: 'File it.',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ];

    expect(missingSuccessfulPlanTools(record.plan, record.calls)).toEqual([
      'create_course',
    ]);
  });

  it('rejects notes and global structures outside a selected-note scope', async () => {
    const first = await createNoteCommand({ title: 'In scope' });
    const second = await createNoteCommand({ title: 'Outside' });
    if (!first.ok || !second.ok) throw new Error('fixture failed');
    const record = run({ kind: 'selection', noteIds: [first.value.id] });
    const signal = new AbortController().signal;

    await expect(
      executeAgentTool(record, 'read_note', { noteId: second.value.id }, signal),
    ).resolves.toMatchObject({ ok: false, code: 'scope_denied' });
    await expect(
      executeAgentTool(record, 'create_course', { name: 'Not allowed' }, signal),
    ).resolves.toMatchObject({ ok: false, code: 'scope_denied' });
  });

  it('links the first pre-edit snapshot to the run and restores it as one undo', async () => {
    const created = await createNoteCommand({ title: 'Original', doc: emptyDoc() });
    if (!created.ok) throw new Error(created.message);
    const record = run({ kind: 'selection', noteIds: [created.value.id] });

    const changed = await executeAgentTool(
      record,
      'update_note',
      {
        noteId: created.value.id,
        baseUpdatedAt: created.value.updatedAt,
        title: 'Changed by agent',
        markdown: 'Agent text',
      },
      new AbortController().signal,
    );
    expect(changed.ok).toBe(true);
    expect(record.touchedNotes).toHaveLength(1);
    const snapshotId = record.touchedNotes[0]?.snapshotId;
    expect(snapshotId).toBeTruthy();
    expect((await library.getSnapshot(snapshotId!))?.runId).toBe(record.id);

    record.status = 'completed';
    useAgentStore.getState().putRun(record);
    const undone = await undoAgentRunCommand(record.id);
    expect(undone.ok).toBe(true);
    expect(await library.getNote(created.value.id)).toMatchObject({
      title: 'Original',
      plainText: '',
    });
    expect(useAgentStore.getState().runs[0]?.status).toBe('undone');
  });

  it('archives created notes and removes their created tags on whole-run undo', async () => {
    const record = run({ kind: 'library' });
    const created = await executeAgentTool(
      record,
      'create_note',
      { title: 'Agent output', markdown: 'A result', tags: ['exam:review'] },
      new AbortController().signal,
    );
    expect(created.ok).toBe(true);
    if (!created.ok || typeof created.value !== 'object' || created.value === null)
      return;
    const noteId = (created.value as { id: string }).id;
    expect(record.undoJournal.createdTagIds).toHaveLength(1);

    record.status = 'completed';
    useAgentStore.getState().putRun(record);
    await expect(undoAgentRunCommand(record.id)).resolves.toMatchObject({ ok: true });
    expect((await library.getNote(noteId))?.archived).toBe(true);
    expect(await library.listTags()).toEqual([]);
  });

  it('preserves a run-created tag that another note started using', async () => {
    const record = run({ kind: 'library' });
    const created = await executeAgentTool(
      record,
      'create_note',
      { title: 'Agent output', tags: ['shared-later'] },
      new AbortController().signal,
    );
    expect(created.ok).toBe(true);
    const tagId = record.undoJournal.createdTagIds[0];
    if (!tagId) throw new Error('agent did not journal its tag');

    const external = await createNoteCommand({ title: 'Concurrent user note' });
    if (!external.ok) throw new Error(external.message);
    const tagged = await updateNoteCommand({
      noteId: external.value.id,
      baseUpdatedAt: external.value.updatedAt,
      tagIds: [tagId],
    });
    if (!tagged.ok) throw new Error(tagged.message);

    record.status = 'completed';
    useAgentStore.getState().putRun(record);
    await expect(undoAgentRunCommand(record.id)).resolves.toMatchObject({ ok: true });
    expect(await library.listTags()).toEqual([
      expect.objectContaining({ id: tagId, name: 'shared-later' }),
    ]);
    expect((await library.getNote(external.value.id))?.tagIds).toEqual([tagId]);
  });
});
