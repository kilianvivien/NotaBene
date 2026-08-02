/**
 * The TypeScript half of the ranking-parity contract.
 *
 * `src-tauri/src/db/notes.rs` reads the same fixture and asserts the same order
 * against SQLite's `bm25()`. Two independent BM25 implementations will drift
 * unless something pins them, and the drift would surface as `pnpm dev` and the
 * desktop build disagreeing about which notes answer a question — the kind of
 * difference that is invisible until a student reports it.
 *
 * Scores are never compared, only order: the two implementations smooth
 * differently and FTS5 promises nothing about absolute values.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createNote } from '@/lib/schema';
import { MemoryLibraryAdapter } from './memoryLibraryAdapter';
import corpus from '@/lib/search/fixtures/ranking-corpus.json';

describe('ranking parity', () => {
  let library: MemoryLibraryAdapter;

  beforeEach(async () => {
    library = new MemoryLibraryAdapter();
    await library.init();
    for (const note of corpus.notes) {
      await library.upsertNote({
        ...createNote(),
        id: note.id,
        title: note.title,
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: note.body }] }],
        },
        plainText: note.body,
      });
    }
  });

  for (const query of corpus.queries) {
    it(`ranks ${query.terms.join(' ')} the way SQLite does`, async () => {
      const found = await library.searchNotes({
        text: query.terms.join(' '),
        textMatch: 'any',
      });
      const ids = found.map((match) => match.note.id);

      expect(ids[0], `wrong top result (got ${ids.join(', ')})`).toBe(query.expectTop);
      for (const absent of query.expectAbsent) {
        expect(ids, `${absent} should not match`).not.toContain(absent);
      }
    });
  }
});
