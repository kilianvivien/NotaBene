/**
 * Retrieval end to end, against the in-memory library.
 *
 * The assertion that matters most is the first one: scope `note` must behave
 * exactly as the Ask panel did before retrieval existed — one source, no search.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { library } from '@/lib/adapters';
import { createCourse, createNote, type Note } from '@/lib/schema';
import { gatherAskSourcesCommand } from './retrievalCommands';

function seed(
  id: string,
  title: string,
  body: string,
  overrides: Partial<Note> = {},
): Note {
  return {
    ...createNote(),
    id,
    title,
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    },
    plainText: body,
    ...overrides,
  };
}

describe('gatherAskSourcesCommand', () => {
  beforeEach(async () => {
    for (const note of await library.queryNotes({ scope: 'all' })) {
      await library.purgeNote(note.id);
    }
    await library.upsertCourse(createCourse({ id: 'algebra', name: 'Algèbre' }));
  });

  it('does not search at all when the scope is the open note', async () => {
    await library.upsertNote(seed('anchor', 'Cours 4', 'un vecteur propre ne tourne pas'));
    await library.upsertNote(seed('other', 'Cours 5', 'un vecteur propre encore'));
    const spy = vi.spyOn(library, 'searchNotes');

    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'anchor',
      scope: 'note',
      question: 'vecteur propre',
    });

    expect(result.ok && result.value.sources).toHaveLength(1);
    expect(result.ok && result.value.sources[0]!.noteId).toBe('anchor');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('finds a note the question shares no exact phrase with', async () => {
    await library.upsertNote(seed('anchor', 'Sommaire', 'plan du cours'));
    await library.upsertNote(
      seed('lecture', 'Vecteurs propres', 'un vecteur propre ne tourne pas'),
    );
    await library.upsertNote(seed('noise', 'Chimie', 'titrage et pH'));

    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'anchor',
      scope: 'library',
      question: 'quel vecteur garde sa direction ?',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources[0]!.noteId).toBe('anchor');
    expect(result.value.sources.map((source) => source.noteId)).toContain('lecture');
    expect(result.value.sources.map((source) => source.noteId)).not.toContain('noise');
  });

  it('stays inside the course when asked to', async () => {
    await library.upsertNote(
      seed('anchor', 'Sommaire', 'plan', { courseId: 'algebra' }),
    );
    await library.upsertNote(
      seed('inside', 'Vecteurs', 'vecteur propre', { courseId: 'algebra' }),
    );
    await library.upsertNote(seed('outside', 'Ailleurs', 'vecteur propre'));

    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'anchor',
      scope: 'course',
      question: 'vecteur propre',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.sources.map((source) => source.noteId);
    expect(ids).toContain('inside');
    expect(ids).not.toContain('outside');
  });

  it('pulls in a wiki-linked note even when the words do not match', async () => {
    await library.upsertNote(seed('related', 'Annexe', 'contenu sans rapport lexical'));
    const anchor = seed('anchor', 'Cours', 'voir aussi');
    anchor.doc.content.push({
      type: 'paragraph',
      content: [
        { type: 'wikiLink', attrs: { noteId: 'related', title: 'Annexe' } },
      ],
    });
    await library.upsertNote(anchor);

    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'anchor',
      scope: 'library',
      question: 'explique le théorème spectral',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const related = result.value.sources.find((source) => source.noteId === 'related');
    expect(related?.reason).toBe('link');
  });

  it('never returns an archived or trashed note', async () => {
    await library.upsertNote(seed('anchor', 'Cours', 'plan'));
    await library.upsertNote(
      seed('archived', 'Vieux', 'vecteur propre', { archived: true }),
    );
    await library.upsertNote(seed('live', 'Actuel', 'vecteur propre'));

    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'anchor',
      scope: 'library',
      question: 'vecteur propre',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.sources.map((source) => source.noteId);
    expect(ids).toContain('live');
    expect(ids).not.toContain('archived');
  });

  it('falls back to recent notes when the question has no content words', async () => {
    await library.upsertNote(seed('anchor', 'Cours', 'plan'));
    await library.upsertNote(
      seed('recent', 'Hier', 'du contenu', {
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
    );

    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'anchor',
      scope: 'library',
      question: 'why is that so?',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.keywords).toEqual([]);
    expect(result.value.sources.map((source) => source.noteId)).toContain('recent');
  });

  it('reports a missing anchor rather than answering from nothing', async () => {
    const result = await gatherAskSourcesCommand({
      anchorNoteId: 'nope',
      scope: 'library',
      question: 'anything',
    });
    expect(result.ok).toBe(false);
  });
});
