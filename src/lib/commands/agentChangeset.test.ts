/**
 * Previewing a bulk change before it lands (plan §3.2 item 8).
 *
 * The loop itself is replaced by a script of tool calls, because what is under
 * test is what the command layer does with them: record instead of write,
 * apply small changesets on its own, hold large ones for the student, skip a
 * note the student edited meanwhile, and keep all of it inside whole-run undo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { AgentLoopRequest } from '@/lib/ai';
import type { AgentRunRecord, AgentToolName, Note, NoteDoc } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import {
  CHANGESET_REVIEW_THRESHOLD,
  planStagesChanges,
  splitForStaging,
  summarizeChangeset,
} from './agentChangeset';
import {
  applyAgentChangesetCommand,
  discardAgentChangesetCommand,
  executeAgentTool,
  runAgentCommand,
  undoAgentRunCommand,
} from './agentCommands';
import { createCourseCommand } from './organizationCommands';
import { createNoteCommand, updateNoteCommand } from './noteCommands';

type Script = (request: AgentLoopRequest) => Promise<void>;
const loop = vi.hoisted(() => ({ script: null as null | Script }));

vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>();
  return {
    ...actual,
    resolveFeature: () => ({
      available: true,
      definition: actual.providerById('anthropic')!,
      model: 'test-model',
    }),
    loadProvider: async () => ({
      definition: actual.providerById('anthropic')!,
      baseUrl: 'http://model.test',
      apiKey: 'k',
      model: 'test-model',
    }),
    runAgentLoop: async (request: AgentLoopRequest) => {
      await loop.script!(request);
      return {
        summary: 'Done',
        outcomeAchieved: true,
        toolCalls: 0,
        tokensUsed: 0,
        questions: 0,
        condensations: 0,
      };
    },
  };
});

function docOf(text: string): NoteDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

async function notes(count: number, courseId: string | null = null): Promise<Note[]> {
  const created: Note[] = [];
  for (let index = 0; index < count; index += 1) {
    const note = await createNoteCommand({
      title: `Week ${index + 1}`,
      doc: docOf(`Lecture ${index + 1}`),
      courseId,
    });
    if (!note.ok) throw new Error(note.message);
    created.push(note.value);
  }
  return created;
}

function versioned(list: Note[]) {
  return list.map((note) => ({ noteId: note.id, baseUpdatedAt: note.updatedAt }));
}

function planned(tools: AgentToolName[]): AgentRunRecord {
  const run: AgentRunRecord = {
    id: `agent-changeset-${Math.random()}`,
    instruction: 'Tidy the notes.',
    scope: { kind: 'library' },
    plan: {
      summary: 'Tidy',
      noteReferences: [],
      steps: [{ description: 'Tidy', expectedTools: tools, noteIds: [] }],
    },
    budget: { tokenCeiling: 1_000_000, toolCallCeiling: 40, wallClockMs: 60_000 },
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
  return run;
}

/** Run the plan with a scripted loop and return the stored record. */
async function execute(run: AgentRunRecord, script: Script) {
  loop.script = script;
  const result = await runAgentCommand(run.id);
  if (!result.ok) throw new Error(result.message);
  return useAgentStore.getState().runs.find((entry) => entry.id === run.id)!;
}

/** One tool call as the real loop makes it, journal callbacks included —
 * the plan audit reads the call records they write. */
async function call(request: AgentLoopRequest, tool: AgentToolName, args: object) {
  const event = {
    callId: `call-${Math.random()}`,
    decision: {
      action: 'tool' as const,
      tool,
      arguments: args as Record<string, unknown>,
      rationale: 'scripted',
    },
  };
  request.onToolStart?.(event);
  const outcome = await request.executeTool(
    tool,
    args as Record<string, unknown>,
    new AbortController().signal,
  );
  request.onToolFinish?.({ ...event, outcome });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  localStorage.clear();
  useAgentStore.setState({ runs: [], activeRunId: null });
  loop.script = null;
});

describe('the changeset as data', () => {
  it('stages a run only when its plan makes metadata writes', () => {
    expect(planStagesChanges(planned(['archive_notes']).plan)).toBe(true);
    expect(planStagesChanges(planned(['update_note', 'read_note']).plan)).toBe(false);
  });

  it('creates a section at once and holds back only the moves', () => {
    const split = splitForStaging('organize', {
      createSection: { courseId: 'c', name: 'Week 4' },
      moves: [{ noteId: 'n', baseUpdatedAt: 't', courseId: 'c', sectionId: 's' }],
    });
    expect(split.now).toEqual({ createSection: { courseId: 'c', name: 'Week 4' } });
    expect(split.staged).toMatchObject({ moves: [{ noteId: 'n' }] });
  });

  it('never stages a tag rename, which is global rather than a change to notes', () => {
    const args = { notes: [], rename: [{ tagId: 't', name: 'x', namespace: null }] };
    expect(splitForStaging('manage_tags', args)).toEqual({ now: args, staged: null });
  });

  it('counts distinct notes, grouped the way the student reviews them', () => {
    const ref = (noteId: string) => ({ noteId, baseUpdatedAt: 't' });
    const summary = summarizeChangeset([
      {
        id: '1',
        tool: 'organize',
        arguments: {
          moves: [
            { ...ref('a'), courseId: 'law', sectionId: 'w4' },
            { ...ref('b'), courseId: 'law', sectionId: 'w4' },
          ],
        },
      },
      { id: '2', tool: 'manage_tags', arguments: { notes: [ref('a'), ref('c')], add: ['topic:tort'] } },
      { id: '3', tool: 'manage_tags', arguments: { notes: [ref('a')], add: ['topic:tort'] } },
      { id: '4', tool: 'archive_notes', arguments: { notes: [ref('c')] } },
    ]);
    expect(summary).toMatchObject({
      notes: 3,
      moves: [{ courseId: 'law', sectionId: 'w4', count: 2 }],
      tagsAdded: [{ name: 'topic:tort', count: 2 }],
      archived: 1,
      trashed: 0,
    });
  });
});

describe('staging and applying', () => {
  it('applies a small changeset as the run finishes', async () => {
    const few = await notes(3);
    const run = planned(['archive_notes']);
    const done = await execute(run, async (request) => {
      const staged = await call(request, 'archive_notes', { notes: versioned(few) });
      expect(staged).toMatchObject({ staged: true, notes: 3 });
      // Nothing lands while the run is still working.
      expect((await memoryLibraryAdapter.getNote(few[0]!.id))?.archived).toBe(false);
    });
    expect(done.status).toBe('completed');
    expect(done.changeset?.state).toBe('applied');
    expect((await memoryLibraryAdapter.getNote(few[0]!.id))?.archived).toBe(true);
  });

  it('holds a large changeset until the student applies it', async () => {
    const many = await notes(CHANGESET_REVIEW_THRESHOLD + 2);
    const run = planned(['manage_tags']);
    const done = await execute(run, async (request) => {
      await call(request, 'manage_tags', { notes: versioned(many), add: ['topic:midterm'] });
    });
    expect(done.status).toBe('completed');
    expect(done.changeset?.state).toBe('pending');
    expect((await memoryLibraryAdapter.getNote(many[0]!.id))?.tagIds).toEqual([]);

    const applied = await applyAgentChangesetCommand(run.id);
    expect(applied.ok).toBe(true);
    for (const note of many) {
      expect((await memoryLibraryAdapter.getNote(note.id))?.tagIds).toHaveLength(1);
    }
    expect(useAgentStore.getState().runs[0]?.changeset?.state).toBe('applied');
  });

  it('writes nothing when the student cancels', async () => {
    const many = await notes(CHANGESET_REVIEW_THRESHOLD + 1);
    const run = planned(['trash_notes']);
    await execute(run, async (request) => {
      await call(request, 'trash_notes', { notes: versioned(many) });
    });
    const discarded = discardAgentChangesetCommand(run.id);
    expect(discarded.ok).toBe(true);
    for (const note of many) {
      expect((await memoryLibraryAdapter.getNote(note.id))?.trashedAt).toBeNull();
    }
    expect((await applyAgentChangesetCommand(run.id)).ok).toBe(false);
  });

  it('chains two staged changes to one note, and skips a note the student edited', async () => {
    const many = await notes(CHANGESET_REVIEW_THRESHOLD + 1);
    const run = planned(['manage_tags', 'archive_notes']);
    await execute(run, async (request) => {
      await call(request, 'manage_tags', { notes: versioned(many), add: ['type:old'] });
      await call(request, 'archive_notes', { notes: versioned(many) });
    });
    // The student keeps working while the changeset waits.
    const edited = await updateNoteCommand({
      noteId: many[0]!.id,
      doc: docOf('Rewritten by hand'),
    });
    if (!edited.ok) throw new Error(edited.message);

    await applyAgentChangesetCommand(run.id);
    const untouched = await memoryLibraryAdapter.getNote(many[0]!.id);
    expect(untouched?.archived).toBe(false);
    expect(untouched?.tagIds).toEqual([]);
    const other = await memoryLibraryAdapter.getNote(many[1]!.id);
    expect(other?.archived).toBe(true);
    expect(other?.tagIds).toHaveLength(1);

    const stored = useAgentStore.getState().runs[0]!;
    expect(stored.changeset?.skipped).toEqual([{ noteId: many[0]!.id, title: 'Week 1' }]);
  });

  it('refuses a stale read while the model can still recover from it', async () => {
    const [note] = await notes(1);
    const record = planned(['archive_notes']);
    record.changeset = { state: 'staging', calls: [], noteVersions: {} };
    const outcome = await executeAgentTool(
      record,
      'archive_notes',
      { notes: [{ noteId: note!.id, baseUpdatedAt: '2000-01-01T00:00:00.000Z' }] },
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'conflict' });
    expect(record.changeset.calls).toHaveLength(0);
  });

  it('creates a section at once so the staged moves can name it', async () => {
    const course = await createCourseCommand({ name: 'Constitutional Law' });
    if (!course.ok) throw new Error(course.message);
    const many = await notes(CHANGESET_REVIEW_THRESHOLD + 1, course.value.id);
    const run = planned(['organize']);
    await execute(run, async (request) => {
      const created = (await call(request, 'organize', {
        createSection: { courseId: course.value.id, name: 'Week 4' },
      })) as { id?: string; section?: { id: string } };
      const sections = await memoryLibraryAdapter.listSections(course.value.id);
      expect(sections.map((section) => section.name)).toEqual(['Week 4']);
      expect(created).toBeTruthy();
      await call(request, 'organize', {
        moves: many.map((note) => ({
          noteId: note.id,
          baseUpdatedAt: note.updatedAt,
          courseId: course.value.id,
          sectionId: sections[0]!.id,
        })),
      });
    });
    expect((await memoryLibraryAdapter.getNote(many[0]!.id))?.sectionId).toBeNull();
    await applyAgentChangesetCommand(run.id);
    expect((await memoryLibraryAdapter.getNote(many[0]!.id))?.sectionId).not.toBeNull();
  });

  it('puts an applied changeset back with the rest of the run on undo', async () => {
    const many = await notes(CHANGESET_REVIEW_THRESHOLD + 1);
    const run = planned(['archive_notes']);
    await execute(run, async (request) => {
      await call(request, 'archive_notes', { notes: versioned(many) });
    });
    await applyAgentChangesetCommand(run.id);
    expect((await memoryLibraryAdapter.getNote(many[3]!.id))?.archived).toBe(true);

    const undone = await undoAgentRunCommand(run.id);
    expect(undone.ok).toBe(true);
    expect((await memoryLibraryAdapter.getNote(many[3]!.id))?.archived).toBe(false);
  });

  it('holds what a failed run staged rather than applying it unseen', async () => {
    const few = await notes(2);
    const run = planned(['archive_notes', 'manage_tags']);
    loop.script = async (request) => {
      await call(request, 'archive_notes', { notes: versioned(few) });
      // The plan also promised tags, which never happened.
    };
    const result = await runAgentCommand(run.id);
    expect(result.ok).toBe(false);
    const stored = useAgentStore.getState().runs.find((entry) => entry.id === run.id)!;
    expect(stored.changeset?.state).toBe('pending');
    expect((await memoryLibraryAdapter.getNote(few[0]!.id))?.archived).toBe(false);
  });
});
