import { describe, expect, it } from 'vitest';
import type { NoteDoc } from '@/lib/schema';
import { estimateTokens, MAX_INPUT_TOKENS } from './client';
import {
  fuseCandidates,
  headingSectionWindow,
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

function sectioned(...sections: [heading: string, body: string][]): NoteDoc {
  return {
    type: 'doc',
    content: sections.flatMap(([heading, body]) => [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: heading }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: body }] },
    ]),
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
      [
        candidate({ noteId: 'anchor', score: 99 }),
        candidate({ noteId: 'other', score: 1 }),
      ],
      'anchor',
    );
    expect(fused.map((entry) => entry.noteId)).toEqual(['other']);
  });

  it('puts the stronger text match first', () => {
    const fused = fuseCandidates(
      [
        candidate({ noteId: 'weak', score: 1 }),
        candidate({ noteId: 'strong', score: 9 }),
      ],
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
    expect(fused[0]!.normalizedTextScore).toBe(1);
    expect(fused[0]!.recencyScore).toBeGreaterThan(0);
  });

  it('does not let recency overturn a clearly better text match', () => {
    const fused = fuseCandidates(
      [
        candidate({ noteId: 'fresh', score: 0, updatedAt: '2026-08-01T00:00:00.000Z' }),
        candidate({
          noteId: 'relevant',
          score: 100,
          updatedAt: '2020-01-01T00:00:00.000Z',
        }),
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

  it('marks a note it had to window, and keeps the matching heading section', () => {
    const doc = sectioned(
      ['Introduction', 'x'.repeat(12_000)],
      ['Eigenvectors', 'the eigenvector does not rotate'],
      ['Appendix', 'y'.repeat(12_000)],
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
    expect(windowed?.trace.section?.heading).toBe('Eigenvectors');
    expect(windowed?.trace.matchedKeywords).toEqual(['eigenvector']);
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

describe('headingSectionWindow', () => {
  it('centres on the best-matching heading section rather than the start', () => {
    const doc = sectioned(
      ['Introduction', 'filler'],
      ['Eigenvectors', 'the eigenvector paragraph'],
      ['Appendix', 'tail'],
    );
    const budget = estimateTokens('## Eigenvectors\n\nthe eigenvector paragraph');
    const window = headingSectionWindow(doc, ['eigenvector'], budget);
    expect(JSON.stringify(window?.doc)).toContain('eigenvector');
    expect(JSON.stringify(window?.doc)).not.toContain('Introduction');
    expect(window?.heading).toBe('Eigenvectors');
    expect(window?.startBlock).toBe(2);
    expect(window?.endBlock).toBe(3);
  });

  it('grows outwards by complete sections when the budget allows', () => {
    const doc = sectioned(
      ['Introduction', 'intro'],
      ['Eigenvectors', 'the eigenvector paragraph'],
      ['Appendix', 'tail'],
    );
    const window = headingSectionWindow(doc, ['eigenvector'], 10_000);
    expect(window?.doc.content).toHaveLength(6);
  });

  it('does not split an oversized unheaded note into arbitrary blocks', () => {
    expect(headingSectionWindow(paragraphs('x'.repeat(10_000)), [], 10)).toBeNull();
  });

  it('keeps a preamble as its own section', () => {
    const doc: NoteDoc = {
      type: 'doc',
      content: [
        ...paragraphs('short preamble').content,
        ...sectioned(['Details', 'longer material']).content,
      ],
    };
    const window = headingSectionWindow(
      doc,
      ['preamble'],
      estimateTokens('short preamble'),
    );
    expect(window?.heading).toBeNull();
    expect(window?.startBlock).toBe(0);
    expect(window?.endBlock).toBe(0);
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
