import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { library } from '@/lib/adapters';
import { useUiStore } from '@/lib/state/uiStore';
import {
  archiveNotesCommand,
  fileNotesCommand,
  mergeNotesCommand,
  mergeOrder,
  tagNotesCommand,
  trashNotesCommand,
} from './bulkCommands';
import { createNoteCommand } from './noteCommands';
import type { Note, NoteDoc } from '@/lib/schema';

function docOf(text: string): NoteDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

async function makeNote(title: string, body = title): Promise<Note> {
  const result = await createNoteCommand({ title, doc: docOf(body) });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  useUiStore.getState().clearMultiSelection();
  useUiStore.getState().selectNote(null);
});

describe('fileNotesCommand', () => {
  it('moves every note in the selection', async () => {
    const a = await makeNote('A');
    const b = await makeNote('B');

    const result = await fileNotesCommand([a.id, b.id], { courseId: 'course-1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changed).toBe(2);

    expect((await library.getNote(a.id))?.courseId).toBe('course-1');
    expect((await library.getNote(b.id))?.courseId).toBe('course-1');
  });

  it('leaves a note that is already there untouched', async () => {
    const a = await makeNote('A');
    await fileNotesCommand([a.id], { courseId: 'course-1', sectionId: null });
    const filed = await library.getNote(a.id);

    const again = await fileNotesCommand([a.id], { courseId: 'course-1' });
    if (!again.ok) throw new Error(again.message);
    // No write, so no new `updatedAt` — re-filing must not reshuffle a
    // date-sorted list.
    expect(again.value.changed).toBe(0);
    expect((await library.getNote(a.id))?.updatedAt).toBe(filed?.updatedAt);
  });

  it('refuses an empty selection rather than succeeding at nothing', async () => {
    const result = await fileNotesCommand([], { courseId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_input');
  });
});

describe('tagNotesCommand', () => {
  it('adds a tag once, however many times it is asked', async () => {
    const a = await makeNote('A');
    await tagNotesCommand([a.id], 'tag-1', 'add');
    await tagNotesCommand([a.id], 'tag-1', 'add');
    expect((await library.getNote(a.id))?.tagIds).toEqual(['tag-1']);
  });

  it('removes a tag from the whole selection', async () => {
    const a = await makeNote('A');
    const b = await makeNote('B');
    await tagNotesCommand([a.id, b.id], 'tag-1', 'add');

    const result = await tagNotesCommand([a.id, b.id], 'tag-1', 'remove');
    if (!result.ok) throw new Error(result.message);
    expect(result.value.changed).toBe(2);
    expect((await library.getNote(b.id))?.tagIds).toEqual([]);
  });
});

describe('trashNotesCommand', () => {
  it('trashes the selection and drops it', async () => {
    const a = await makeNote('A');
    const b = await makeNote('B');
    useUiStore.getState().setMultiSelection([a.id, b.id]);

    const result = await trashNotesCommand([a.id, b.id]);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.changed).toBe(2);
    expect((await library.getNote(a.id))?.trashedAt).toBeTruthy();
    expect(useUiStore.getState().multiSelection).toEqual([]);
  });

  it('checks every revision before moving the first note', async () => {
    const a = await makeNote('A');
    const b = await makeNote('B');
    const result = await trashNotesCommand(
      [a.id, b.id],
      { source: 'agent' },
      {
        [a.id]: a.updatedAt,
        [b.id]: '2020-01-01T00:00:00.000Z',
      },
    );

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect((await library.getNote(a.id))?.trashedAt).toBeNull();
    expect((await library.getNote(b.id))?.trashedAt).toBeNull();
  });
});

describe('mergeOrder', () => {
  it('puts the most recently edited note first', () => {
    const ordered = mergeOrder([
      { updatedAt: '2026-01-01T00:00:00.000Z', id: 'old' },
      { updatedAt: '2026-08-01T00:00:00.000Z', id: 'new' },
    ]);
    expect(ordered.map((note) => note.id)).toEqual(['new', 'old']);
  });
});

describe('mergeNotesCommand', () => {
  it('honours the order it is given rather than re-sorting it', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');

    const result = await mergeNotesCommand({
      noteIds: [b.id, a.id],
      sourceFate: 'keep',
    });
    if (!result.ok) throw new Error(result.message);

    const titles = result.value.doc.content
      .filter((node) => node.type === 'heading')
      .map((node) => node.content?.[0]?.text);
    expect(titles).toEqual(['Beta', 'Alpha']);
  });

  it('takes its title from the note on top unless told otherwise', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');

    const fromTop = await mergeNotesCommand({
      noteIds: [b.id, a.id],
      sourceFate: 'keep',
    });
    if (!fromTop.ok) throw new Error(fromTop.message);
    expect(fromTop.value.title).toBe('Beta');

    const named = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      title: '  Revision sheet  ',
      sourceFate: 'keep',
    });
    if (!named.ok) throw new Error(named.message);
    expect(named.value.title).toBe('Revision sheet');
  });

  it('inherits a course only when every source agreed on one', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');
    await fileNotesCommand([a.id, b.id], { courseId: 'course-1', sectionId: null });

    const same = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'keep',
    });
    if (!same.ok) throw new Error(same.message);
    expect(same.value.courseId).toBe('course-1');

    await fileNotesCommand([b.id], { courseId: 'course-2', sectionId: null });
    const split = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'keep',
    });
    if (!split.ok) throw new Error(split.message);
    expect(split.value.courseId).toBeNull();
  });

  it('unions the sources tags', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');
    await tagNotesCommand([a.id], 'tag-1', 'add');
    await tagNotesCommand([b.id], 'tag-2', 'add');

    const result = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'keep',
    });
    if (!result.ok) throw new Error(result.message);
    expect([...result.value.tagIds].sort()).toEqual(['tag-1', 'tag-2']);
  });

  it('trashes the sources only when asked, and only after the merge exists', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');

    const kept = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'keep',
    });
    if (!kept.ok) throw new Error(kept.message);
    expect((await library.getNote(a.id))?.trashedAt).toBeFalsy();

    const trashed = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'trash',
    });
    if (!trashed.ok) throw new Error(trashed.message);
    expect((await library.getNote(a.id))?.trashedAt).toBeTruthy();
    expect((await library.getNote(trashed.value.id))?.trashedAt).toBeFalsy();
  });

  it('archives the sources when that is the fate chosen', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');
    const result = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'archive',
    });
    if (!result.ok) throw new Error(result.message);
    expect((await library.getNote(a.id))?.archived).toBe(true);
    expect((await library.getNote(result.value.id))?.archived).toBe(false);
  });

  it('refuses fewer than two notes', async () => {
    const a = await makeNote('Alpha');
    const result = await mergeNotesCommand({ noteIds: [a.id], sourceFate: 'keep' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_input');
  });

  it('checks every source revision before creating the merged note', async () => {
    const a = await makeNote('Alpha');
    const b = await makeNote('Beta');
    const result = await mergeNotesCommand({
      noteIds: [a.id, b.id],
      sourceFate: 'keep',
      baseUpdatedAtByNoteId: {
        [a.id]: a.updatedAt,
        [b.id]: '2020-01-01T00:00:00.000Z',
      },
    });

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(await library.queryNotes({ scope: 'all' })).toHaveLength(2);
  });
});

describe('archiveNotesCommand', () => {
  it('archives and unarchives a whole selection', async () => {
    const a = await makeNote('A');
    const b = await makeNote('B');

    await archiveNotesCommand([a.id, b.id], true);
    expect((await library.getNote(a.id))?.archived).toBe(true);

    await archiveNotesCommand([a.id, b.id], false);
    expect((await library.getNote(b.id))?.archived).toBe(false);
  });
});
