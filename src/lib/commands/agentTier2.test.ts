/**
 * The agent's tier 2 tools (plan §3.2 items 5–7), through the same executor a
 * run uses — so scope, journalling and the token ceiling are exercised along
 * with the handlers, not beside them.
 *
 * Only the model is replaced. Everything from provider lookup to the write is
 * the real command path, because what matters here is where the output lands
 * and that whole-run undo can find it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentImporter } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { ImportedDocument, NoteDoc } from '@/lib/schema';
import type { AgentRunRecord, AgentScope } from '@/lib/schema';
import { useAgentStore } from '@/lib/state/agentStore';
import { BUDGET_EXHAUSTED } from '@/lib/ai';
import { executeAgentTool, undoAgentRunCommand } from './agentCommands';
import { addAttachmentCommand } from './assetCommands';
import { createNoteCommand, updateNoteCommand } from './noteCommands';
import { savePdfAnnotationsCommand } from './pdfAnnotationCommands';

const model = vi.hoisted(() => ({
  requestFlashcards: vi.fn(),
  requestSynthesis: vi.fn(),
  requestMindMap: vi.fn(),
}));

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
    ...model,
  };
});

function docOf(text: string): NoteDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function run(scope: AgentScope, tokenCeiling = 1_000_000): AgentRunRecord {
  return {
    id: `agent-tier2-${Math.random()}`,
    instruction: 'Exercise tier 2.',
    scope,
    plan: {
      summary: 'Test',
      noteReferences: [],
      steps: [{ description: 'Read', expectedTools: ['read_note'], noteIds: [] }],
    },
    budget: { tokenCeiling, toolCallCeiling: 10, wallClockMs: 10_000 },
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

async function note(text: string, title = text) {
  const created = await createNoteCommand({ title, doc: docOf(text) });
  if (!created.ok) throw new Error(created.message);
  return created.value;
}

function signal() {
  return new AbortController().signal;
}

function importedDocument(markdown: string): ImportedDocument {
  return {
    source: { filename: 'paper.pdf', format: 'pdf' },
    markdown,
    assets: [],
    diagnostics: { parser: 'anydoc', warnings: [], requiresOcr: false },
  };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  localStorage.clear();
  useAgentStore.setState({ runs: [], activeRunId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.values(model).forEach((mock) => mock.mockReset());
});

describe('attachments and highlights (item 5)', () => {
  async function paper(pdfText = 'x') {
    const owner = await note('Reading notes');
    const attached = await addAttachmentCommand(
      owner.id,
      new File([pdfText], 'paper.pdf', { type: 'application/pdf' }),
    );
    if (!attached.ok) throw new Error(attached.message);
    return { owner, attachment: attached.value };
  }

  it('lists a note’s attachments with their highlights in page order', async () => {
    const { owner, attachment } = await paper();
    const at = new Date().toISOString();
    const rect = { x1: 0, y1: 0, x2: 1, y2: 1 };
    const saved = await savePdfAnnotationsCommand(attachment, [
      { id: 'b', page: 7, rects: [rect], text: 'later', comment: '', color: 'yellow', createdAt: at, updatedAt: at },
      { id: 'a', page: 2, rects: [rect], text: 'earlier', comment: 'key claim', color: 'green', createdAt: at, updatedAt: at },
    ]);
    if (!saved.ok) throw new Error(saved.message);

    const result = await executeAgentTool(
      run({ kind: 'library' }),
      'list_annotations',
      { noteId: owner.id },
      signal(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: [
        {
          attachmentId: attachment.id,
          name: 'paper.pdf',
          annotations: [
            { page: 2, text: 'earlier', comment: 'key claim' },
            { page: 7, text: 'later' },
          ],
        },
      ],
    });
  });

  it('checks scope through the owning note', async () => {
    const { owner, attachment } = await paper();
    const other = await note('Unrelated');
    const record = run({ kind: 'selection', noteIds: [other.id] });

    for (const [tool, args] of [
      ['list_annotations', { noteId: owner.id }],
      ['read_attachment', { noteId: owner.id, attachmentId: attachment.id }],
    ] as const) {
      const result = await executeAgentTool(record, tool, args, signal());
      expect(result).toMatchObject({ ok: false, code: 'scope_denied' });
    }
  });

  it('refuses an attachment that belongs to another note', async () => {
    const { attachment } = await paper();
    const other = await note('Other');
    const result = await executeAgentTool(
      run({ kind: 'library' }),
      'read_attachment',
      { noteId: other.id, attachmentId: attachment.id },
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('pages the extracted text and converts the document only once', async () => {
    const { owner, attachment } = await paper('distinct bytes for this test');
    const body = `${'a'.repeat(1_500)}![fig](nb-import-asset:img1)\n${'b'.repeat(1_000)}`;
    const extract = vi
      .spyOn(documentImporter, 'extractBytes')
      .mockResolvedValue(importedDocument(body));
    const record = run({ kind: 'library' });

    const first = await executeAgentTool(
      record,
      'read_attachment',
      { noteId: owner.id, attachmentId: attachment.id, maxChars: 2_000 },
      signal(),
    );
    expect(first).toMatchObject({
      ok: true,
      value: { offset: 0, totalChars: 2_500, nextOffset: 2_000 },
    });
    if (!first.ok) return;
    expect((first.value as { text: string }).text).not.toContain('nb-import-asset');

    const second = await executeAgentTool(
      record,
      'read_attachment',
      { noteId: owner.id, attachmentId: attachment.id, offset: 2_000, maxChars: 2_000 },
      signal(),
    );
    expect(second).toMatchObject({
      ok: true,
      value: { offset: 2_000, nextOffset: null, text: 'b'.repeat(500) },
    });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('says a scanned document needs the student before it can be read', async () => {
    const { owner, attachment } = await paper('scanned bytes');
    vi.spyOn(documentImporter, 'extractBytes').mockRejectedValue(
      new Error('ocr_required:[1,2]/2:pages 1, 2 of 2 need OCR'),
    );
    const result = await executeAgentTool(
      run({ kind: 'library' }),
      'read_attachment',
      { noteId: owner.id, attachmentId: attachment.id },
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_supported' });
    if (result.ok) return;
    expect(result.message).toMatch(/text recognition/);
  });
});

describe('note history (item 6)', () => {
  it('lists versions newest first and reads one back as Markdown', async () => {
    const original = await note('First draft', 'Essay');
    const edited = await updateNoteCommand(
      { noteId: original.id, doc: docOf('Second draft') },
      { source: 'ai' },
    );
    if (!edited.ok) throw new Error(edited.message);
    const record = run({ kind: 'library' });

    const listed = await executeAgentTool(
      record,
      'list_versions',
      { noteId: original.id },
      signal(),
    );
    expect(listed).toMatchObject({
      ok: true,
      value: { currentUpdatedAt: edited.value.updatedAt, versions: [{ cause: 'ai' }] },
    });
    if (!listed.ok) return;
    const [version] = (listed.value as { versions: { versionId: string }[] }).versions;

    const read = await executeAgentTool(
      record,
      'read_version',
      { noteId: original.id, versionId: version!.versionId },
      signal(),
    );
    expect(read).toMatchObject({ ok: true, value: { title: 'Essay' } });
    if (!read.ok) return;
    expect((read.value as { markdown: string }).markdown).toContain('First draft');
  });

  it('will not read another note’s version past the scope check', async () => {
    const secret = await note('Private', 'Diary');
    await updateNoteCommand({ noteId: secret.id, doc: docOf('Edited') }, { source: 'ai' });
    const [version] = await memoryLibraryAdapter.listSnapshots(secret.id);
    const allowed = await note('Allowed');

    const result = await executeAgentTool(
      run({ kind: 'selection', noteIds: [allowed.id] }),
      'read_version',
      { noteId: allowed.id, versionId: version!.id },
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('study features as tools (item 7)', () => {
  const deck = {
    title: 'Week 4',
    cards: [
      { kind: 'basic', front: 'What is a tort?', back: 'A civil wrong.' },
      { kind: 'basic', front: 'Who bears the burden?', back: 'The claimant.' },
    ],
  };

  it('appends a deck to the target as the run, and undo takes it back out', async () => {
    const source = await note('Torts lecture');
    const target = await note('Revision', 'Revision');
    model.requestFlashcards.mockResolvedValue(deck);
    const record = run({ kind: 'library' });

    const result = await executeAgentTool(
      record,
      'generate_flashcards',
      {
        noteIds: [source.id],
        target: { noteId: target.id, baseUpdatedAt: target.updatedAt },
      },
      signal(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { noteId: target.id, cards: 2, deckTitle: 'Week 4' },
    });
    expect(result.modelTokens).toBeGreaterThan(0);
    // The source was read, not written: only the target is journalled.
    expect(record.touchedNotes.map((entry) => entry.noteId)).toEqual([target.id]);
    expect(record.touchedNotes[0]?.snapshotId).not.toBeNull();

    const written = await memoryLibraryAdapter.getNote(target.id);
    expect(written?.plainText).toContain('What is a tort?');

    useAgentStore.getState().putRun({ ...record, status: 'completed' });
    const undone = await undoAgentRunCommand(record.id);
    expect(undone.ok).toBe(true);
    const restored = await memoryLibraryAdapter.getNote(target.id);
    expect(restored?.plainText).not.toContain('What is a tort?');
  });

  it('checks the target’s version before paying for the model', async () => {
    const source = await note('Torts lecture');
    const target = await note('Revision');
    const result = await executeAgentTool(
      run({ kind: 'library' }),
      'generate_flashcards',
      {
        noteIds: [source.id],
        target: { noteId: target.id, baseUpdatedAt: '2000-01-01T00:00:00.000Z' },
      },
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(model.requestFlashcards).not.toHaveBeenCalled();
  });

  it('files a synthesis as a note the run created, so undo archives it', async () => {
    const a = await note('Contract formation');
    const b = await note('Consideration');
    model.requestSynthesis.mockResolvedValue({
      title: 'Contracts summary',
      doc: docOf('Offer, acceptance, consideration.'),
    });
    const record = run({ kind: 'selection', noteIds: [a.id, b.id] });

    const result = await executeAgentTool(
      record,
      'synthesize_notes',
      { noteIds: [a.id, b.id], style: 'summary' },
      signal(),
    );
    expect(result).toMatchObject({ ok: true, value: { title: 'Contracts summary' } });
    if (!result.ok) return;
    const createdId = (result.value as { id: string }).id;
    expect(record.undoJournal.createdNoteIds).toContain(createdId);
    expect(record.undoJournal.createdTagIds.length).toBe(1);

    useAgentStore.getState().putRun({ ...record, status: 'completed' });
    await undoAgentRunCommand(record.id);
    expect((await memoryLibraryAdapter.getNote(createdId))?.archived).toBe(true);
  });

  it('keeps synthesis sources inside the scope', async () => {
    const allowed = await note('Allowed');
    const outside = await note('Outside');
    const result = await executeAgentTool(
      run({ kind: 'selection', noteIds: [allowed.id] }),
      'synthesize_notes',
      { noteIds: [allowed.id, outside.id] },
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: 'scope_denied' });
    expect(model.requestSynthesis).not.toHaveBeenCalled();
  });

  it('refuses a model call that would not fit in the token ceiling', async () => {
    const long = await note('x'.repeat(40_000), 'Long reading');
    const record = run({ kind: 'library' }, 12_000);
    const result = await executeAgentTool(
      record,
      'visualize_note',
      { noteId: long.id, baseUpdatedAt: long.updatedAt },
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: BUDGET_EXHAUSTED });
    expect(model.requestMindMap).not.toHaveBeenCalled();
  });

  it('appends a mind map without taking the editor away', async () => {
    const source = await note('Photosynthesis');
    model.requestMindMap.mockResolvedValue({
      map: {
        title: 'Photosynthesis',
        nodes: [{ id: 'root', label: 'Photosynthesis' }],
        edges: [],
      },
      svg: '<svg />',
    });
    const record = run({ kind: 'library' });
    const result = await executeAgentTool(
      record,
      'visualize_note',
      { noteId: source.id, baseUpdatedAt: source.updatedAt, kind: 'mindmap' },
      signal(),
    );
    expect(result).toMatchObject({ ok: true });
    const written = await memoryLibraryAdapter.getNote(source.id);
    expect(written?.doc.content.at(-1)?.type).toBe('mindMap');
    expect(record.touchedNotes[0]?.noteId).toBe(source.id);
  });
});
