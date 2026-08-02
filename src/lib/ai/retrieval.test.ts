import { describe, expect, it } from 'vitest';
import type { NoteDoc } from '@/lib/schema';
import { estimateTokens, MAX_INPUT_TOKENS } from './client';
import {
  blockWindow,
  fuseCandidates,
  packSources,
  sourceBudget,
  MAX_SOURCES,
  type AnchorNote,
  type Candidate,
} from './retrieval';

function paragraphs(...texts: string[]): NoteDoc {
  return {
    type: 'doc',
    content: texts.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  };
}

function candidate(overrides: Partial<Candidate> & { noteId: string }): Candidate {
  return {
    title: overrides.noteId,
    courseId: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    score: 0,
    linked: false,
    ...overrides,
  };
}

const anchor: AnchorNote = {
  noteId: 'anchor',
  title: 'Open note',
  courseId: 'course-1',
  doc: paragraphs('the note the student has open'),
};

describe('fuseCandidates', () => {
  it('never ranks the anchor — it is not competing', () => {
    const fused = fuseCandidates(
      [candidate({ noteId: 'anchor', score: 99 }), candidate({ noteId: 'other', score: 1 })],
      'anchor',
    );
    expect(fused.map((entry) => entry.noteId)).toEqual(['other']);
  });

  it('puts the stronger text match first', () => {
    const fused = fuseCandidates(
      [candidate({ noteId: 'weak', score: 1 }), candidate({ noteId: 'strong', score: 9 })],
      'anchor',
    );
    expect(fused[0]!.noteId).toBe('strong');
  });

  it('lets a wiki link break a tie between equal text scores', () => {
    const fused = fuseCandidates(
      [
        candidate({ noteId: 'plain', score: 5 }),
        candidate({ noteId: 'linked', score: 5, linked: true }),
      ],
      'anchor',
    );
    expect(fused[0]!.noteId).toBe('linked');
  });

  it('does not let recency overturn a clearly better text match', () => {
    const fused = fuseCandidates(
      [
        candidate({ noteId: 'fresh', score: 0, updatedAt: '2026-08-01T00:00:00.000Z' }),
        candidate({ noteId: 'relevant', score: 100, updatedAt: '2020-01-01T00:00:00.000Z' }),
      ],
      'anchor',
      new Date('2026-08-02T00:00:00.000Z'),
    );
    expect(fused[0]!.noteId).toBe('relevant');
  });
});

describe('packSources', () => {
  it('always puts the anchor first and whole', () => {
    const { sources } = packSources(
      anchor,
      [
        {
          candidate: candidate({ noteId: 'other', score: 100 }),
          doc: paragraphs('something else'),
        },
      ],
      ['something'],
      10_000,
    );
    expect(sources[0]!.noteId).toBe('anchor');
    expect(sources[0]!.reason).toBe('anchor');
    expect(sources[0]!.truncated).toBe(false);
  });

  it('stops at MAX_SOURCES and counts the rest as dropped', () => {
    const ranked = Array.from({ length: MAX_SOURCES + 5 }, (_, index) => ({
      candidate: candidate({ noteId: `n${index}`, score: 10 - index }),
      doc: paragraphs('court'),
    }));
    const { sources, droppedCount } = packSources(anchor, ranked, [], 1_000_000);
    // The anchor holds one of the slots, so one fewer candidate fits than the
    // cap suggests.
    expect(sources).toHaveLength(MAX_SOURCES);
    expect(droppedCount).toBe(ranked.length - (MAX_SOURCES - 1));
  });

  it('stops when the budget runs out', () => {
    const long = paragraphs('x'.repeat(20_000));
    const ranked = [
      { candidate: candidate({ noteId: 'a' }), doc: long },
      { candidate: candidate({ noteId: 'b' }), doc: long },
      { candidate: candidate({ noteId: 'c' }), doc: long },
    ];
    const { sources, droppedCount } = packSources(anchor, ranked, [], 8_000);
    expect(sources.length).toBeLessThan(4);
    expect(droppedCount).toBeGreaterThan(0);
  });

  it('marks a note it had to window, and keeps the matching passage', () => {
    const doc = paragraphs(
      'x'.repeat(4_000),
      'the eigenvector does not rotate',
      'y'.repeat(4_000),
    );
    const { sources } = packSources(
      anchor,
      [{ candidate: candidate({ noteId: 'long' }), doc }],
      ['eigenvector'],
      2_000,
    );
    const windowed = sources.find((source) => source.noteId === 'long');
    expect(windowed?.truncated).toBe(true);
    expect(JSON.stringify(windowed?.doc)).toContain('eigenvector');
  });

  it('reports a link-sourced note as such', () => {
    const { sources } = packSources(
      anchor,
      [
        {
          candidate: candidate({ noteId: 'linked', linked: true }),
          doc: paragraphs('related'),
        },
      ],
      [],
      10_000,
    );
    expect(sources[1]!.reason).toBe('link');
  });
});

describe('blockWindow', () => {
  it('centres on the best-matching block rather than the start of the note', () => {
    const doc = paragraphs('intro', 'filler', 'the eigenvector paragraph', 'tail');
    const window = blockWindow(doc, ['eigenvector'], estimateTokens('the eigenvector paragraph'));
    expect(JSON.stringify(window)).toContain('eigenvector');
    expect(JSON.stringify(window)).not.toContain('intro');
  });

  it('grows outwards for context when the budget allows', () => {
    const doc = paragraphs('intro', 'the eigenvector paragraph', 'tail');
    const window = blockWindow(doc, ['eigenvector'], 10_000);
    expect(window?.content).toHaveLength(3);
  });

  it('gives up rather than return a fragment too big to send', () => {
    expect(blockWindow(paragraphs('x'.repeat(10_000)), [], 10)).toBeNull();
  });
});

describe('sourceBudget', () => {
  it('shrinks as the conversation grows', () => {
    const long = 'word '.repeat(100_000);
    expect(sourceBudget(long)).toBeLessThan(sourceBudget('short question'));
  });

  it('keeps the whole request under the refusal ceiling', () => {
    const spoken = 'word '.repeat(60_000);
    expect(sourceBudget(spoken) + estimateTokens(spoken)).toBeLessThan(MAX_INPUT_TOKENS);
  });
});
