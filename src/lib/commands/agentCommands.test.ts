import { beforeEach, describe, expect, it } from 'vitest';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import {
  AgentRunRecordSchema,
  emptyDoc,
  type AgentPlan,
  type AgentRunRecord,
  type AgentScope,
  type AgentToolName,
} from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { createNoteCommand, updateNoteCommand } from './noteCommands';
import {
  executeAgentTool,
  finalizeAgentPlan,
  missingSuccessfulPlanTools,
  planNeedsReview,
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
  it('keeps follow-up linkage compatible with the persisted run schema', () => {
    const parent = run({ kind: 'library' });
    const parsed = AgentRunRecordSchema.parse({
      ...parent,
      id: 'follow-up-run',
      parentRunId: parent.id,
      instruction: 'Make it shorter.',
    });

    expect(parsed.parentRunId).toBe(parent.id);
  });

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

  it('treats repeated planned tool names as capabilities, not call counts', () => {
    const record = run({ kind: 'library' });
    record.plan.steps = [
      {
        description: 'Check the note.',
        expectedTools: ['read_note'],
        noteIds: [],
      },
      {
        description: 'Use what was checked.',
        expectedTools: ['read_note', 'create_note'],
        noteIds: [],
      },
    ];
    record.calls = [
      {
        id: 'read-once',
        tool: 'read_note',
        arguments: { noteId: 'note-1' },
        rationale: 'Check it once.',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'create-once',
        tool: 'create_note',
        arguments: { title: 'Copy' },
        rationale: 'Create the result.',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ];

    expect(missingSuccessfulPlanTools(record.plan, record.calls)).toEqual([]);
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
    await expect(
      executeAgentTool(
        record,
        'create_note',
        {
          copyFrom: {
            noteId: second.value.id,
            baseUpdatedAt: second.value.updatedAt,
          },
        },
        signal,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'scope_denied' });
  });

  it('checks every note in a bulk call against the scope, in either shape', async () => {
    const inside = await createNoteCommand({ title: 'In scope' });
    const outside = await createNoteCommand({ title: 'Outside' });
    if (!inside.ok || !outside.ok) throw new Error('fixture failed');
    const record = run({ kind: 'selection', noteIds: [inside.value.id] });
    const signal = new AbortController().signal;

    await expect(
      executeAgentTool(
        record,
        'archive_notes',
        {
          notes: [
            { noteId: inside.value.id, baseUpdatedAt: inside.value.updatedAt },
            { noteId: outside.value.id, baseUpdatedAt: outside.value.updatedAt },
          ],
        },
        signal,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'scope_denied' });

    // The list form of manage_tags must not be a way around the check the
    // single-note form has always had.
    await expect(
      executeAgentTool(
        record,
        'manage_tags',
        {
          notes: [{ noteId: outside.value.id, baseUpdatedAt: outside.value.updatedAt }],
          add: ['revision'],
        },
        signal,
      ),
    ).resolves.toMatchObject({ ok: false, code: 'scope_denied' });
  });

  it('journals every note of a bulk tag write, so one undo puts them all back', async () => {
    const first = await createNoteCommand({ title: 'First' });
    const second = await createNoteCommand({ title: 'Second' });
    if (!first.ok || !second.ok) throw new Error('fixture failed');
    const record = run({ kind: 'library' });

    const tagged = await executeAgentTool(
      record,
      'manage_tags',
      {
        notes: [
          { noteId: first.value.id, baseUpdatedAt: first.value.updatedAt },
          { noteId: second.value.id, baseUpdatedAt: second.value.updatedAt },
        ],
        add: ['exam:final'],
      },
      new AbortController().signal,
    );
    expect(tagged).toMatchObject({ ok: true, value: { changed: 2 } });
    expect((await library.getNote(first.value.id))?.tagIds).toHaveLength(1);
    expect((await library.getNote(second.value.id))?.tagIds).toHaveLength(1);
    expect(record.undoJournal.notesBefore).toHaveLength(2);

    record.status = 'completed';
    useAgentStore.getState().putRun(record);
    expect((await undoAgentRunCommand(record.id)).ok).toBe(true);
    expect((await library.getNote(first.value.id))?.tagIds).toEqual([]);
    expect((await library.getNote(second.value.id))?.tagIds).toEqual([]);
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

  it('undoes a merge by restoring trashed sources and archiving the merged note', async () => {
    const first = await createNoteCommand({ title: 'First', doc: emptyDoc() });
    const second = await createNoteCommand({ title: 'Second', doc: emptyDoc() });
    if (!first.ok || !second.ok) throw new Error('fixture failed');
    const record = run({
      kind: 'selection',
      noteIds: [first.value.id, second.value.id],
    });

    const merged = await executeAgentTool(
      record,
      'merge_notes',
      {
        notes: [
          { noteId: first.value.id, baseUpdatedAt: first.value.updatedAt },
          { noteId: second.value.id, baseUpdatedAt: second.value.updatedAt },
        ],
        title: 'Combined',
        sourceFate: 'trash',
      },
      new AbortController().signal,
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok || typeof merged.value !== 'object' || merged.value === null) return;
    const mergedId = (merged.value as { id: string }).id;
    expect((await library.getNote(first.value.id))?.trashedAt).toBeTruthy();
    expect((await library.getNote(second.value.id))?.trashedAt).toBeTruthy();

    record.status = 'completed';
    useAgentStore.getState().putRun(record);
    await expect(undoAgentRunCommand(record.id)).resolves.toMatchObject({ ok: true });
    expect((await library.getNote(first.value.id))?.trashedAt).toBeNull();
    expect((await library.getNote(second.value.id))?.trashedAt).toBeNull();
    expect(await library.getNote(mergedId)).toMatchObject({ archived: true });
  });

  it('returns an originally trashed note to Trash when a restore run is undone', async () => {
    const created = await createNoteCommand({ title: 'In Trash', doc: emptyDoc() });
    if (!created.ok) throw new Error(created.message);
    await library.trashNote(created.value.id);
    const trashed = await library.getNote(created.value.id);
    if (!trashed) throw new Error('fixture failed');
    const record = run({ kind: 'selection', noteIds: [trashed.id] });

    await expect(
      executeAgentTool(
        record,
        'restore_notes',
        { notes: [{ noteId: trashed.id, baseUpdatedAt: trashed.updatedAt }] },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect((await library.getNote(trashed.id))?.trashedAt).toBeNull();

    record.status = 'completed';
    useAgentStore.getState().putRun(record);
    await expect(undoAgentRunCommand(record.id)).resolves.toMatchObject({ ok: true });
    expect((await library.getNote(trashed.id))?.trashedAt).toBeTruthy();
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

describe('the completion audit', () => {
  const plan = (expectedTools: AgentToolName[]): AgentPlan => ({
    summary: 'Do it',
    noteReferences: [],
    steps: [{ description: 'Do it', expectedTools, noteIds: [] }],
  });
  const done = (tool: AgentToolName, args: Record<string, unknown> = {}) =>
    ({
      id: tool,
      tool,
      arguments: args,
      rationale: 'r',
      status: 'succeeded',
      startedAt: new Date(0).toISOString(),
    }) as const;

  it('owes the planned changes, not the planned reads', () => {
    expect(
      missingSuccessfulPlanTools(plan(['search_notes', 'read_attachment', 'organize']), [
        done('list_notes'),
        done('organize'),
      ]),
    ).toEqual([]);
    expect(
      missingSuccessfulPlanTools(plan(['read_note', 'update_note']), [done('read_note')]),
    ).toEqual(['update_note']);
  });

  it('counts a task created with its notes as linked', () => {
    expect(
      missingSuccessfulPlanTools(plan(['create_task', 'link_task_note']), [
        done('create_task', { title: 'PS1', noteIds: ['n1'] }),
      ]),
    ).toEqual([]);
    expect(
      missingSuccessfulPlanTools(plan(['create_task', 'link_task_note']), [
        done('create_task', { title: 'PS1' }),
      ]),
    ).toEqual(['link_task_note']);
  });
});

describe('whether a plan waits for review', () => {
  const plan = (
    expectedTools: AgentToolName[][],
    complexity?: 'simple' | 'complex',
  ): AgentPlan => ({
    summary: 'Do it',
    noteReferences: [],
    complexity,
    steps: expectedTools.map((tools) => ({
      description: 'Do it',
      expectedTools: tools,
      noteIds: [],
    })),
  });

  it('lets a small plan run, and holds a large or risky one', () => {
    expect(
      planNeedsReview(plan([['read_note'], ['manage_tags']], 'simple'), 'large'),
    ).toBe(false);
    expect(planNeedsReview(plan([['manage_tags']], 'complex'), 'large')).toBe(true);
    // The planner cannot call Trash or a merge simple.
    expect(planNeedsReview(plan([['trash_notes']], 'simple'), 'large')).toBe(true);
    expect(planNeedsReview(plan([['merge_notes']], 'simple'), 'large')).toBe(true);
    // Nor five changing steps.
    expect(
      planNeedsReview(
        plan(
          Array.from({ length: 5 }, () => ['update_note']),
          'simple',
        ),
        'large',
      ),
    ).toBe(true);
    expect(planNeedsReview(plan([['manage_tags']], 'simple'), 'always')).toBe(true);
  });

  it('stops owing a planned change the model found unnecessary', () => {
    const done = {
      id: 'r',
      tool: 'read_note' as const,
      arguments: {},
      rationale: 'r',
      status: 'succeeded' as const,
      startedAt: new Date(0).toISOString(),
    };
    expect(
      missingSuccessfulPlanTools(plan([['read_note'], ['organize']]), [done]),
    ).toEqual(['organize']);
    expect(
      missingSuccessfulPlanTools(
        plan([['read_note'], ['organize']]),
        [done],
        ['organize'],
      ),
    ).toEqual([]);
  });
});
