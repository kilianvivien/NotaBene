import { describe, expect, it } from 'vitest';
import type { CourseTerm, TranscriptWord } from '@/lib/schema';
import type { TranscriptParagraph } from './paragraphs';
import { correctFromVocabulary, hintTerms, lectureVocabulary } from './vocabulary';

function term(text: string, status: CourseTerm['status'] = 'accepted'): CourseTerm {
  return {
    id: text,
    courseId: 'c',
    term: text,
    status,
    source: 'user',
    createdAt: '2026-09-28T10:00:00.000Z',
  };
}

const NOTE = {
  id: 'n',
  title: 'Photosynthèse',
  plainText: 'La phase lumineuse a lieu dans les thylakoïdes. Le cycle de Calvin suit.',
};

function paragraph(...words: [string, number | null][]): TranscriptParagraph {
  return {
    startMs: 0,
    endMs: words.length * 300,
    words: words.map(([text, confidence], index): TranscriptWord => ({
      text,
      start: index * 0.3,
      end: index * 0.3 + 0.3,
      confidence,
    })),
  };
}

const texts = (paragraphs: TranscriptParagraph[]) =>
  paragraphs[0]!.words.map((word) => word.text).join(' ');

describe('lectureVocabulary', () => {
  it('puts curated terms first, then the lecture note, and leaves rejected terms out', () => {
    const vocabulary = lectureVocabulary({
      curated: [term('Rubisco'), term('photosynthese', 'rejected')],
      note: NOTE,
      harvested: [],
    });
    expect(vocabulary[0]).toMatchObject({ term: 'Rubisco', source: 'curated' });
    expect(vocabulary.map((entry) => entry.term)).toContain('thylakoïdes');
    // The note title's "Photosynthèse" folds to the rejected term's key.
    expect(vocabulary.some((entry) => entry.key === 'photosynthese')).toBe(false);
    expect(hintTerms(vocabulary, 1)).toEqual(['Rubisco']);
  });
});

describe('correctFromVocabulary', () => {
  const vocabulary = lectureVocabulary({
    curated: [term('photosynthèse')],
    note: NOTE,
    harvested: [],
  });

  it('respells a doubtful near miss, keeping its capital, punctuation and doubt', () => {
    const { paragraphs, corrected } = correctFromVocabulary(
      [paragraph(['les', 0.95], ['Thyloïdes,', 0.3])],
      vocabulary,
    );
    expect(corrected).toBe(1);
    expect(texts(paragraphs)).toBe('les Thylakoïdes,');
    expect(paragraphs[0]!.words[1]!.confidence).toBe(0.3);
  });

  it('joins two doubtful words that are one term misheard', () => {
    const { paragraphs, corrected } = correctFromVocabulary(
      [paragraph(['la', 0.9], ['photo', 0.2], ['santes', 0.25], ['et', 0.9])],
      vocabulary,
    );
    expect(corrected).toBe(1);
    expect(texts(paragraphs)).toBe('la photosynthèse et');
    const joined = paragraphs[0]!.words[1]!;
    expect(joined).toMatchObject({ start: 0.3, confidence: 0.2 });
    expect(joined.end).toBeCloseTo(0.9);
  });

  it('leaves confident words, inflections, unknown words and missing confidences alone', () => {
    const input = [
      paragraph(
        ['thyloïdes', 0.9], // confident: not ours to second-guess
        ['thylakoïde', 0.3], // a singular, not a mishearing
        ['sique', 0.3], // nothing in the vocabulary is close
        ['thyloïdes', null], // no confidence is not low confidence
      ),
    ];
    const { paragraphs, corrected } = correctFromVocabulary(input, vocabulary);
    expect(corrected).toBe(0);
    expect(paragraphs).toEqual(input);
  });

  it('does nothing without a vocabulary', () => {
    const input = [paragraph(['thyloïdes', 0.2])];
    expect(correctFromVocabulary(input, [])).toEqual({ paragraphs: input, corrected: 0 });
  });
});
