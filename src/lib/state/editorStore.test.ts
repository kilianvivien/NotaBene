import { beforeEach, describe, expect, it, vi } from 'vitest';
import { library } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createNoteCommand } from '@/lib/commands/noteCommands';
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
