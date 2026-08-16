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
import { createCourse, createNote, newId } from '@/lib/schema';
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

/**
 * The shared corpus carries only titles and bodies, so it can say nothing about
 * the other three indexed columns — which is how they came to be mapped in the
 * wrong order here without a single test noticing. `BM25_WEIGHTS` is positional
 * and mirrors `notes_fts`'s column order (title, plainText, tags, course,
 * attachments); getting that mapping wrong silently swaps two weights rather
 * than failing anywhere.
 *
 * This stays out of the fixture on purpose: `src-tauri/src/db/notes.rs` reads
 * the same JSON, and widening it means changing the Rust half in step.
 */
describe('indexed column weights', () => {
  let library: MemoryLibraryAdapter;

  beforeEach(async () => {
    library = new MemoryLibraryAdapter();
    await library.init();
  });

  it('weights a tag hit above a course hit, as the schema order says', async () => {
    // A course and a tag may legitimately share a name, which is what makes
    // this comparison possible at all.
    const course = createCourse({ name: 'Thermodynamics' });
    await library.upsertCourse(course);
    const tagId = newId();
    await library.upsertTag({
      id: tagId,
      namespace: 'topic',
      name: 'Thermodynamics',
      color: '#9b5c2f',
    });

    const body = 'Nothing in this sentence names the subject.';
    const doc = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    };
    await library.upsertNote({
      ...createNote(),
      id: 'tagged',
      title: 'Second lecture',
      doc,
      plainText: body,
      tagIds: [tagId],
    });
    await library.upsertNote({
      ...createNote(),
      id: 'filed',
      title: 'Third lecture',
      doc,
      plainText: body,
      courseId: course.id,
    });

    const found = await library.searchNotes({ text: 'thermodynamics' });
    const ids = found.map((match) => match.note.id);

    expect(ids).toHaveLength(2);
    expect(ids[0], `tags carry weight 6 and course 3 (got ${ids.join(', ')})`).toBe(
      'tagged',
    );
  });
});
