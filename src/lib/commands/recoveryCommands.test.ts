import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { library } from '@/lib/adapters';
import { createNoteCommand } from './noteCommands';
import { discardJournalCommand, recoverJournalCommand } from './recoveryCommands';
import type { Note, NoteDoc } from '@/lib/schema';

function docOf(text: string): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** Stand in for the editor's journal timer: record in-flight state one minute
 * after the note was last saved, which is what a crash leaves behind. */
async function journalAfterSave(note: Note, text: string): Promise<void> {
  const writtenAt = new Date(Date.parse(note.updatedAt) + 60_000).toISOString();
  await library.writeJournal({
    noteId: note.id,
    doc: docOf(text),
    title: note.title,
    writtenAt,
  });
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('crash recovery', () => {
  it('offers a journal row that outlived its note', async () => {
    const created = await createNoteCommand({ doc: docOf('saved text') });
    if (!created.ok) throw new Error(created.message);
    await journalAfterSave(created.value, 'text lost to the crash');

    const pending = await library.pendingRecoveries();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.noteId).toBe(created.value.id);
  });

  it('does not offer a journal row the save already superseded', async () => {
    const created = await createNoteCommand({ doc: docOf('saved text') });
    if (!created.ok) throw new Error(created.message);

    await library.writeJournal({
      noteId: created.value.id,
      doc: docOf('older in-flight text'),
      title: created.value.title,
      // Written *before* the last save: nothing here was lost.
      writtenAt: new Date(Date.parse(created.value.updatedAt) - 60_000).toISOString(),
    });

    expect(await library.pendingRecoveries()).toHaveLength(0);
  });

  it('recovers through the command layer, so the saved version lands in history', async () => {
    const created = await createNoteCommand({ doc: docOf('saved text') });
    if (!created.ok) throw new Error(created.message);
    await journalAfterSave(created.value, 'text lost to the crash');

    const result = await recoverJournalCommand(created.value.id);
    expect(result.ok).toBe(true);

    const stored = await library.getNote(created.value.id);
    expect(stored?.plainText).toBe('text lost to the crash');

    // A mistaken recovery has to be undoable too.
    const snapshots = await library.listSnapshots(created.value.id);
    expect(snapshots).toHaveLength(1);
    expect(await library.pendingRecoveries()).toHaveLength(0);
  });

  it('discards only the unsaved tail, never the saved note', async () => {
    const created = await createNoteCommand({ doc: docOf('saved text') });
    if (!created.ok) throw new Error(created.message);
    await journalAfterSave(created.value, 'text lost to the crash');

    await discardJournalCommand(created.value.id);

    expect(await library.pendingRecoveries()).toHaveLength(0);
    expect((await library.getNote(created.value.id))?.plainText).toBe('saved text');
  });

  it('retires the journal row when an ordinary save catches up', async () => {
    const created = await createNoteCommand({ doc: docOf('saved text') });
    if (!created.ok) throw new Error(created.message);
    await journalAfterSave(created.value, 'in flight');

    await library.upsertNote({ ...created.value, updatedAt: new Date().toISOString() });

    expect(await library.pendingRecoveries()).toHaveLength(0);
  });

  it('reports a note with nothing to recover rather than pretending it worked', async () => {
    const result = await recoverJournalCommand('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});
