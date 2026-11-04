import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createNoteCommand, updateNoteCommand } from '@/lib/commands/noteCommands';
import { tagNotesCommand } from '@/lib/commands/bulkCommands';
import type { NoteDoc } from '@/lib/schema';
import { useEditorStore } from './editorStore';

function docOf(text: string): NoteDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  memoryLibraryAdapter.reset();
  useEditorStore.setState({
    note: null,
    saveState: 'idle',
    lastSavedAt: null,
    lastSnapshotAt: null,
    error: null,
    conflict: null,
  });
});

afterEach(async () => {
  await useEditorStore.getState().closeNote();
  vi.useRealTimers();
});

describe('editor synchronization with note commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
  });

  async function openFixture() {
    const created = await createNoteCommand({ title: 'Lecture', doc: docOf('first') });
    if (!created.ok) throw new Error(created.message);
    await useEditorStore.getState().openNote(created.value.id);
    vi.setSystemTime(new Date('2026-11-04T12:00:01.000Z'));
    return created.value;
  }

  it.each([
    { tagIds: ['exam'] },
    { pinned: true },
    { archived: true },
    { courseId: 'course-b', sectionId: 'week-2' },
  ])('can keep typing after changing metadata: %j', async (patch) => {
    const note = await openFixture();
    useEditorStore.getState().applyDoc(docOf('before tagging'));
    const result = await updateNoteCommand({ noteId: note.id, ...patch });
    expect(result.ok).toBe(true);

    vi.setSystemTime(new Date('2026-11-04T12:00:02.000Z'));
    useEditorStore.getState().applyDoc(docOf('after tagging'));
    await useEditorStore.getState().flush();

    expect(useEditorStore.getState().conflict).toBeNull();
    expect(useEditorStore.getState().saveState).toBe('saved');
    expect(await library.getNote(note.id)).toMatchObject({
      ...patch,
      doc: docOf('after tagging'),
    });
  });

  it('preserves typing and title edits made while a tag write is in flight', async () => {
    const note = await openFixture();
    const entered = deferred();
    const gate = deferred();
    const realUpsert = library.upsertNoteIfUnchanged.bind(library);
    vi.spyOn(library, 'upsertNoteIfUnchanged').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return realUpsert(...args);
    });

    const tagging = updateNoteCommand({ noteId: note.id, tagIds: ['exam'] });
    await entered.promise;
    useEditorStore.getState().applyDoc(docOf('typed while tagging'));
    useEditorStore.getState().setTitle('New title');
    const saving = useEditorStore.getState().flush();
    gate.resolve();
    expect((await tagging).ok).toBe(true);
    await saving;

    expect(useEditorStore.getState().conflict).toBeNull();
    expect(await library.getNote(note.id)).toMatchObject({
      tagIds: ['exam'],
      title: 'New title',
      doc: docOf('typed while tagging'),
    });
  });

  it('can keep typing after adding and removing tags through the note-list menu', async () => {
    const note = await openFixture();
    for (const mode of ['add', 'remove'] as const) {
      const result = await tagNotesCommand([note.id], 'exam', mode);
      expect(result.ok).toBe(true);
      vi.setSystemTime(new Date(Date.now() + 1_000));
      useEditorStore.getState().applyDoc(docOf(`after ${mode}`));
      await useEditorStore.getState().flush();

      expect(useEditorStore.getState().conflict).toBeNull();
      expect(await library.getNote(note.id)).toMatchObject({
        tagIds: mode === 'add' ? ['exam'] : [],
        doc: docOf(`after ${mode}`),
      });
    }
  });

  it('retains both copies when typing overlaps a content replacement', async () => {
    const note = await openFixture();
    const entered = deferred();
    const gate = deferred();
    const realUpsert = library.upsertNoteIfUnchanged.bind(library);
    vi.spyOn(library, 'upsertNoteIfUnchanged').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return realUpsert(...args);
    });

    const replacing = updateNoteCommand({ noteId: note.id, doc: docOf('replacement') });
    await entered.promise;
    useEditorStore.getState().applyDoc(docOf('typed during replacement'));
    gate.resolve();
    expect((await replacing).ok).toBe(true);

    expect(useEditorStore.getState().conflict).toMatchObject({
      mine: { doc: docOf('typed during replacement') },
      theirs: { doc: docOf('replacement') },
    });
  });

  it('synchronizes content commands for user and agent writes', async () => {
    const note = await openFixture();
    for (const source of ['user', 'agent'] as const) {
      vi.setSystemTime(new Date(Date.now() + 1_000));
      const result = await updateNoteCommand(
        { noteId: note.id, doc: docOf(source) },
        { source },
      );
      expect(result.ok).toBe(true);
      expect(useEditorStore.getState().note?.doc).toEqual(docOf(source));
      expect(useEditorStore.getState().conflict).toBeNull();
    }
  });

  it('still reports a genuine competing content write', async () => {
    const note = await openFixture();
    await library.upsertNote({
      ...note,
      doc: docOf('another writer'),
      updatedAt: new Date().toISOString(),
    });
    useEditorStore.getState().applyDoc(docOf('my edits'));
    await useEditorStore.getState().flush();

    expect(useEditorStore.getState().conflict).toMatchObject({
      mine: { doc: docOf('my edits') },
      theirs: { doc: docOf('another writer') },
    });
    expect((await library.getNote(note.id))?.doc).toEqual(docOf('another writer'));
  });
});

describe('editor autosave serialization', () => {
  it('keeps and subsequently writes edits made while a save is in flight', async () => {
    const created = await createNoteCommand({ title: 'Race', doc: docOf('first') });
    if (!created.ok) throw new Error(created.message);
    await useEditorStore.getState().openNote(created.value.id);
    useEditorStore.getState().applyDoc(docOf('before save'));

    const gate = deferred();
    const realUpsert = library.upsertNote.bind(library);
    let writes = 0;
    vi.spyOn(library, 'upsertNote').mockImplementation(async (note) => {
      writes += 1;
      if (writes === 1) await gate.promise;
      await realUpsert(note);
    });

    const firstFlush = useEditorStore.getState().flush();
    await vi.waitFor(() => expect(writes).toBe(1));
    useEditorStore.getState().applyDoc(docOf('typed during save'));
    gate.resolve();
    await firstFlush;

    expect(useEditorStore.getState().note?.doc).toEqual(docOf('typed during save'));
    expect(useEditorStore.getState().saveState).toBe('dirty');

    await useEditorStore.getState().flush();
    expect((await library.getNote(created.value.id))?.doc).toEqual(
      docOf('typed during save'),
    );
  });

  it('does not let an in-flight save replace the note opened after it', async () => {
    const a = await createNoteCommand({ title: 'A', doc: docOf('A') });
    const b = await createNoteCommand({ title: 'B', doc: docOf('B') });
    if (!a.ok || !b.ok) throw new Error('failed to create fixtures');
    await useEditorStore.getState().openNote(a.value.id);
    useEditorStore.getState().applyDoc(docOf('A edited'));

    const gate = deferred();
    const realUpsert = library.upsertNote.bind(library);
    vi.spyOn(library, 'upsertNote').mockImplementationOnce(async (note) => {
      await gate.promise;
      await realUpsert(note);
    });

    const saving = useEditorStore.getState().flush();
    await vi.waitFor(() => expect(useEditorStore.getState().saveState).toBe('saving'));
    const opening = useEditorStore.getState().openNote(b.value.id);
    gate.resolve();
    await Promise.all([saving, opening]);

    expect(useEditorStore.getState().note?.id).toBe(b.value.id);
  });
});
