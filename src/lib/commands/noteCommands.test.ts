import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { library } from '@/lib/adapters';
import { useLibraryStore } from '@/lib/state/libraryStore';
import {
  createNoteCommand,
  createNotesCommand,
  fileNoteCommand,
  restoreSnapshotCommand,
  updateNoteCommand,
} from './noteCommands';
import type { NoteDoc } from '@/lib/schema';

function docOf(text: string): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('createNoteCommand', () => {
  it('derives a title from the body when none is given', async () => {
    const result = await createNoteCommand({ doc: docOf('Fourier series') });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe('Fourier series');
  });

  it('recomputes plainText rather than trusting the caller', async () => {
    const result = await createNoteCommand({ doc: docOf('Green theorem') });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.plainText).toBe('Green theorem');
  });

  it('rejects a malformed document without touching the store', async () => {
    // @ts-expect-error deliberately invalid document
    const result = await createNoteCommand({ doc: { type: 'not-a-doc' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_input');
    expect(await library.queryNotes({})).toHaveLength(0);
  });
});

describe('updateNoteCommand', () => {
  it('snapshots the previous content before overwriting it', async () => {
    const created = await createNoteCommand({ doc: docOf('first draft') });
    if (!created.ok) throw new Error(created.message);

    await updateNoteCommand({ noteId: created.value.id, doc: docOf('second draft') });

    const snapshots = await library.listSnapshots(created.value.id);
    expect(snapshots).toHaveLength(1);
  });

  it('does not snapshot a metadata-only change', async () => {
    const created = await createNoteCommand({ doc: docOf('draft') });
    if (!created.ok) throw new Error(created.message);

    await updateNoteCommand({ noteId: created.value.id, pinned: true });

    expect(await library.listSnapshots(created.value.id)).toHaveLength(0);
  });

  it('records an agent edit with its own cause, distinct from a user edit', async () => {
    const created = await createNoteCommand({ doc: docOf('lecture') });
    if (!created.ok) throw new Error(created.message);

    await updateNoteCommand(
      { noteId: created.value.id, doc: docOf('tidied lecture') },
      { source: 'agent', agentName: 'claude-code' },
    );

    const [snapshot] = await library.listSnapshots(created.value.id);
    expect(snapshot?.cause).toBe('agent');
  });

  it('reports a missing note instead of creating one', async () => {
    const result = await updateNoteCommand({ noteId: 'nope', title: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('does not write noteId onto the stored note', async () => {
    const created = await createNoteCommand({ doc: docOf('a') });
    if (!created.ok) throw new Error(created.message);

    await updateNoteCommand({ noteId: created.value.id, title: 'b' });
    const stored = await library.getNote(created.value.id);
    expect(stored).not.toHaveProperty('noteId');
  });
});

describe('fileNoteCommand', () => {
  it('clears the section when the note lands in a different course', async () => {
    const created = await createNoteCommand({
      doc: docOf('week 3'),
      courseId: 'course-a',
      sectionId: 'section-a1',
    });
    if (!created.ok) throw new Error(created.message);

    const moved = await fileNoteCommand(created.value.id, { courseId: 'course-b' });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.value.courseId).toBe('course-b');
      // A section belongs to one course; carrying the id across would leave the
      // note pointing at a section its new course has never heard of.
      expect(moved.value.sectionId).toBeNull();
    }
  });

  it('keeps the section when only the section is named', async () => {
    const created = await createNoteCommand({ doc: docOf('week 4'), courseId: 'course-a' });
    if (!created.ok) throw new Error(created.message);

    const moved = await fileNoteCommand(created.value.id, {
      courseId: 'course-a',
      sectionId: 'section-a2',
    });
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.value.sectionId).toBe('section-a2');
  });

  it('is a no-op when the note is dropped where it already lives', async () => {
    const created = await createNoteCommand({ doc: docOf('week 5'), courseId: 'course-a' });
    if (!created.ok) throw new Error(created.message);

    const moved = await fileNoteCommand(created.value.id, { courseId: 'course-a' });
    expect(moved.ok).toBe(true);
    // No write, so no version: dropping a note back on its own course should
    // not fill the history with entries that changed nothing.
    expect(await library.listSnapshots(created.value.id)).toHaveLength(0);
    if (moved.ok) expect(moved.value.updatedAt).toBe(created.value.updatedAt);
  });

  it('reports a missing note rather than filing nothing quietly', async () => {
    const result = await fileNoteCommand('nope', { courseId: 'course-a' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});

describe('restoreSnapshotCommand', () => {
  it('restores forward: history is added to, never rewound', async () => {
    const created = await createNoteCommand({ doc: docOf('original') });
    if (!created.ok) throw new Error(created.message);

    await updateNoteCommand({ noteId: created.value.id, doc: docOf('replacement') });
    const [snapshot] = await library.listSnapshots(created.value.id);
    if (!snapshot) throw new Error('the update should have left a snapshot behind');

    const restored = await restoreSnapshotCommand(snapshot.id);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.plainText).toBe('original');

    // The restore itself is undoable: the snapshot list only grew.
    expect((await library.listSnapshots(created.value.id)).length).toBeGreaterThan(1);
  });
});


describe('createNotesCommand', () => {
  /** Count refreshes of the note list, which is what a naive loop over the
   *  single-note command would re-run once per note. */
  function countRefreshes() {
    return vi.spyOn(useLibraryStore.getState(), 'refreshCurrentView');
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes every note it was given', async () => {
    const result = await createNotesCommand([
      { title: 'One', doc: docOf('first') },
      { title: 'Two', doc: docOf('second') },
      { title: 'Three', doc: docOf('third') },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    expect(await library.countNotes({ scope: 'live' })).toBe(3);
  });

  it('refreshes the read caches once, not once per note', async () => {
    // The entire reason this command exists. Looping `createNoteCommand`
    // re-runs the note list's query — and every course, tag and count behind
    // it — for each note written.
    const refresh = countRefreshes();
    await createNotesCommand(
      Array.from({ length: 12 }, (_, index) => ({
        title: `Note ${index}`,
        doc: docOf(`body ${index}`),
      })),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports an invalid note by position, having written nothing', async () => {
    // "note 2 is invalid" is actionable in a 900-note vault import where
    // "invalid note input" is not — and the check runs before any write, so a
    // bad note in the middle does not leave half a library behind.
    const result = await createNotesCommand([
      { title: 'Fine', doc: docOf('ok') },
      { title: 'Also fine', doc: docOf('ok') },
      { title: 'Broken', doc: { type: 'not-a-doc' } as unknown as NoteDoc },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_input');
    expect(result.message).toContain('at 2');
    expect(await library.countNotes({ scope: 'live' })).toBe(0);
  });

  it('chunks a large import rather than sending it as one payload', async () => {
    const upsertNotes = vi.spyOn(library, 'upsertNotes');
    await createNotesCommand(
      Array.from({ length: 601 }, (_, index) => ({
        title: `Note ${index}`,
        doc: docOf(`body ${index}`),
      })),
    );

    // 250 + 250 + 101, and still one refresh at the end.
    expect(upsertNotes).toHaveBeenCalledTimes(3);
    expect(upsertNotes.mock.calls[0]?.[0]).toHaveLength(250);
    expect(upsertNotes.mock.calls[2]?.[0]).toHaveLength(101);
    expect(await library.countNotes({ scope: 'live' })).toBe(601);
  });

  it('says how many notes landed when a write fails part-way', async () => {
    // A large import commits chunk by chunk, so "storage failed" alone leaves
    // someone unable to tell whether to retry it or clean up after it.
    const upsertNotes = vi.spyOn(library, 'upsertNotes');
    upsertNotes.mockImplementationOnce(async () => {});
    upsertNotes.mockImplementationOnce(async () => {
      throw new Error('disk full');
    });

    const result = await createNotesCommand(
      Array.from({ length: 400 }, (_, index) => ({
        title: `Note ${index}`,
        doc: docOf(`body ${index}`),
      })),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('storage_failed');
    expect(result.details).toMatchObject({ written: 250 });
  });

  it('writes nothing and refreshes nothing for an empty batch', async () => {
    const refresh = countRefreshes();
    const result = await createNotesCommand([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('wiki title resolution', () => {
  /**
   * These pin the same three choices the SQLite query makes, asserted here
   * against the memory adapter. The Rust counterpart is
   * `click_resolution_and_the_backlink_index_agree_by_construction` in
   * `db/notes.rs`. Two adapters answering a link differently is a bug nobody
   * would find until a vault was already imported.
   */
  it('matches a title case-insensitively', async () => {
    const note = await createNoteCommand({ title: 'Damping', doc: docOf('body') });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    expect(await library.resolveWikiTitle('damping')).toBe(note.value.id);
    expect(await library.resolveWikiTitle('  DAMPING  ')).toBe(note.value.id);
  });

  it('answers null for a title nobody has, rather than throwing', async () => {
    expect(await library.resolveWikiTitle('Nothing')).toBeNull();
    expect(await library.resolveWikiTitle('   ')).toBeNull();
  });

  it('still resolves a trashed note, as the backlink index does', async () => {
    // Trash is recoverable and the index keeps its row either way. Filtering
    // here alone would make a link navigate somewhere the inspector does not
    // list — the disagreement the shared lookup exists to prevent.
    const note = await createNoteCommand({ title: 'Trashed', doc: docOf('body') });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    await library.trashNote(note.value.id);
    expect(await library.resolveWikiTitle('Trashed')).toBe(note.value.id);
  });
});
