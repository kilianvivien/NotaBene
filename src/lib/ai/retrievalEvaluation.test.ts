import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '@/editor/markdown';
import { MemoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createNote } from '@/lib/schema';
import { deriveKeywords } from '@/lib/search/keywords';
import corpus from './fixtures/retrieval-evaluation.json';
import { fuseCandidates, type Candidate } from './retrieval';
import { scoreRetrieval } from './retrievalEvaluation';

const EVALUATION_CUTOFF = 5;
const SCALE_NOTE_COUNT = 3_000;

type EvaluationLibrary = MemoryLibraryAdapter;

async function seedEvaluationLibrary(totalNotes: number): Promise<EvaluationLibrary> {
  const adapter = new MemoryLibraryAdapter();
  await adapter.init();

  await Promise.all(
    corpus.notes.map((note) =>
      adapter.upsertNote(
        createNote({
          id: note.id,
          courseId: note.courseId,
          title: note.title,
          doc: markdownToDoc(note.markdown),
          plainText: note.markdown,
          updatedAt: '2026-08-01T00:00:00.000Z',
        }),
      ),
    ),
  );

  const distractorVocabulary = [
    'matrix vector transformation lecture example',
    'acid base laboratory concentration notes',
    'carbon cycle biology enzyme overview',
    'court law petition contract outline',
    'price demand economics calculation example',
    'integrales theoreme analyse cours',
  ];
  const distractorCount = Math.max(0, totalNotes - corpus.notes.length);
  await Promise.all(
    Array.from({ length: distractorCount }, (_, index) => {
      const body = distractorVocabulary[index % distractorVocabulary.length] ?? '';
      return adapter.upsertNote(
        createNote({
          id: `distractor-${index}`,
          title: `Lecture ${index}`,
          doc: markdownToDoc(`# Lecture ${index}\n\n${body}`),
          plainText: body,
          updatedAt: '2026-08-01T00:00:00.000Z',
        }),
      );
    }),
  );

  return adapter;
}

async function evaluateLibrary(adapter: EvaluationLibrary) {
  const rankedByQuestion = new Map<string, string[]>();
  for (const question of corpus.questions) {
    const keywords = deriveKeywords(question.question);
    expect(keywords).toEqual(question.terms);
    const matches = await adapter.searchNotes({
      text: keywords.join(' '),
      textMatch: 'any',
      scope: 'live',
      sort: 'relevance',
      limit: 40,
    });
    const candidates: Candidate[] = matches.map((match) => ({
      noteId: match.note.id,
      title: match.note.title,
      courseId: match.note.courseId,
      updatedAt: match.note.updatedAt,
      score: match.score,
      linked: false,
    }));
    rankedByQuestion.set(
      question.id,
      fuseCandidates(candidates, 'anchor', new Date('2026-08-12T00:00:00.000Z')).map(
        (candidate) => candidate.noteId,
      ),
    );
  }
  return scoreRetrieval(corpus.questions, rankedByQuestion, EVALUATION_CUTOFF);
}

describe('retrieval quality harness', () => {
  it('scores known rankings with recall@K and reciprocal rank', () => {
    const result = scoreRetrieval(
      [
        { id: 'one', relevantNoteIds: ['a'] },
        { id: 'two', relevantNoteIds: ['b', 'c'] },
      ],
      new Map([
        ['one', ['a']],
        ['two', ['noise', 'b']],
      ]),
      2,
    );

    expect(result).toEqual({
      hitRateAtK: 1,
      recallAtK: 0.75,
      meanReciprocalRank: 0.75,
      score: 0.75,
      cutoff: 2,
      questionCount: 2,
    });
  });

  it('meets the fixed-corpus quality floor', async () => {
    const result = await evaluateLibrary(
      await seedEvaluationLibrary(corpus.notes.length),
    );
    expect(result.questionCount).toBe(corpus.questions.length);
    expect(result.hitRateAtK).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  it('does not lose retrieval quality at 3,000 notes', async () => {
    const small = await evaluateLibrary(await seedEvaluationLibrary(corpus.notes.length));
    const largeLibrary = await seedEvaluationLibrary(SCALE_NOTE_COUNT);
    const started = performance.now();
    const large = await evaluateLibrary(largeLibrary);
    const elapsedMs = performance.now() - started;

    expect(large.questionCount).toBe(corpus.questions.length);
    expect(large.hitRateAtK).toBe(1);
    expect(large.score).toBeGreaterThanOrEqual(small.score - 0.05);
    // A generous regression ceiling, not a product latency claim. The plan's
    // measurement is quality at scale; this merely keeps the harness usable.
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
