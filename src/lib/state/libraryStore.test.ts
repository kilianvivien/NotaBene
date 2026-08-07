import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createNote } from '@/lib/schema';
import { useLibraryStore } from './libraryStore';

beforeEach(() => {
  memoryLibraryAdapter.reset();
  useLibraryStore.setState({
    notes: [],
    totalNotes: 0,
    loadingMore: false,
    lastQuery: { scope: 'live', sort: 'updated', limit: 200 },
  });
});

describe('note list paging', () => {
  it('reports the full count and appends beyond the first 200-note page', async () => {
    for (let index = 0; index < 205; index += 1) {
      await memoryLibraryAdapter.upsertNote(
        createNote({
          id: `note-${String(index).padStart(3, '0')}`,
          title: `Note ${index}`,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        }),
      );
    }

    await useLibraryStore.getState().refreshNotes({
      scope: 'live',
      sort: 'updated',
      limit: 200,
    });
    expect(useLibraryStore.getState().notes).toHaveLength(200);
    expect(useLibraryStore.getState().totalNotes).toBe(205);

    await useLibraryStore.getState().appendNotes();
    expect(useLibraryStore.getState().notes).toHaveLength(205);
    expect(new Set(useLibraryStore.getState().notes.map((note) => note.id)).size).toBe(205);
  });
});
