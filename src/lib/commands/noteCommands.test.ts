import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { library } from '@/lib/adapters';
import { createNoteCommand, restoreSnapshotCommand, updateNoteCommand } from './noteCommands';
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
    expect(snapshot.cause).toBe('agent');
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

describe('restoreSnapshotCommand', () => {
  it('restores forward: history is added to, never rewound', async () => {
    const created = await createNoteCommand({ doc: docOf('original') });
    if (!created.ok) throw new Error(created.message);

    await updateNoteCommand({ noteId: created.value.id, doc: docOf('replacement') });
    const [snapshot] = await library.listSnapshots(created.value.id);

    const restored = await restoreSnapshotCommand(snapshot.id);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.plainText).toBe('original');

    // The restore itself is undoable: the snapshot list only grew.
    expect((await library.listSnapshots(created.value.id)).length).toBeGreaterThan(1);
  });
});
