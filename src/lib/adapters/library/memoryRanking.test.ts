/**
 * Ranking parity for the in-memory adapter.
 *
 * The desktop build ranks in SQLite and this one ranks in JavaScript, so the
 * numbers differ by construction. What must not differ is the *order* a student
 * sees, which is why every assertion here is about which note came first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLibraryAdapter } from './memoryLibraryAdapter';
import { bm25Rank } from './memoryRanking';
import { createNote } from '@/lib/schema';
import type { LibraryAdapter } from './LibraryAdapter';

/** The adapter derives `plainText` from `doc` on every write, so the body has
 * to be a real document — a bare `plainText` would be flattened away. */
function noteWith(id: string, title: string, body: string) {
  return {
    ...createNote(),
    id,
    title,
    doc: {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    },
    plainText: body,
  };
}

describe('bm25Rank', () => {
  it('weights a title hit above a body hit', () => {
    const scores = bm25Rank(
      [
        { id: 'body', fields: ['Semaine 3', 'eigenvector', '', '', ''] },
        { id: 'title', fields: ['Eigenvector', 'notes de cours', '', '', ''] },
      ],
      ['eigenvector'],
    );
    expect(scores.get('title')!).toBeGreaterThan(scores.get('body')!);
  });

  it('matches by prefix and ignores diacritics, like the FTS5 index', () => {
    const scores = bm25Rank(
      [{ id: 'fr', fields: ['Révisions', 'un théorème utile', '', '', ''] }],
      ['theorem'],
    );
    expect(scores.get('fr')).toBeGreaterThan(0);
  });

  it('scores nothing when no term matches', () => {
    const scores = bm25Rank([{ id: 'a', fields: ['Un', 'deux', '', '', ''] }], ['trois']);
    expect(scores.size).toBe(0);
  });
});

describe('memory adapter searchNotes', () => {
  let library: LibraryAdapter;

  beforeEach(async () => {
    library = new MemoryLibraryAdapter();
    await library.init();
  });

  it('finds a note that shares only one word with the question', async () => {
    await library.upsertNote(
      noteWith('lecture', 'Algèbre', 'un vecteur propre ne tourne pas'),
    );
    await library.upsertNote(noteWith('other', 'Chimie', 'rien de commun'));

    const question = 'vecteur direction rotation';
    // AND matching is expected to miss it — that is why retrieval needs OR.
    expect(await library.queryNotes({ text: question })).toHaveLength(0);

    const found = await library.searchNotes({ text: question, textMatch: 'any' });
    expect(found.map((match) => match.note.id)).toEqual(['lecture']);
    expect(found[0]!.score).toBeGreaterThan(0);
  });

  it('ranks by relevance alone, leaving a pinned weak match where it lands', async () => {
    const pinned = { ...noteWith('pinned', 'Divers', 'eigenvector une fois'), pinned: true };
    await library.upsertNote(pinned);
    await library.upsertNote(
      noteWith('strong', 'Eigenvector', 'eigenvector eigenvector'),
    );

    const ranked = await library.searchNotes({ text: 'eigenvector', textMatch: 'any' });
    expect(ranked[0]!.note.id).toBe('strong');

    // …while the note list still floats the pinned one, as every view expects.
    const listed = await library.queryNotes({ text: 'eigenvector', sort: 'relevance' });
    expect(listed[0]!.id).toBe('pinned');
  });

  it('refuses a ranked search with nothing to rank', async () => {
    await expect(library.searchNotes({ text: '  ' })).rejects.toThrow(
      /SEARCH_REQUIRES_TEXT/,
    );
  });

  it('honours the filters the note list honours', async () => {
    await library.upsertNote({
      ...noteWith('archived', 'Eigenvector', 'eigenvector'),
      archived: true,
    });
    await library.upsertNote(noteWith('live', 'Eigenvector', 'eigenvector'));

    const ranked = await library.searchNotes({ text: 'eigenvector', textMatch: 'any' });
    expect(ranked.map((match) => match.note.id)).toEqual(['live']);
  });
});
