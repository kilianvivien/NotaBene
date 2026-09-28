import { describe, expect, it } from 'vitest';
import type { TranscriptSegment, TranscriptWord } from '@/lib/schema';
import { stitchWindows } from './stitch';
import { groupParagraphs } from './paragraphs';
import { transcriptBlocks } from './document';

function word(
  text: string,
  start: number,
  confidence: number | null = 0.95,
): TranscriptWord {
  return { text, start, end: start + 0.3, confidence };
}

function segment(words: TranscriptWord[]): TranscriptSegment {
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: words.map((w) => w.text).join(' '),
    words,
  };
}

describe('stitchWindows', () => {
  it('shifts each window onto the lecture clock and keeps each side of the overlap midpoint', () => {
    // Window 0 is 0–63 s, window 1 starts at 60 s: overlap 60–63, midpoint 61.5.
    const stitched = stitchWindows([
      {
        window: { index: 0, startMs: 0, endMs: 63_000 },
        segments: [segment([word('avant', 59), word('milieu', 61), word('doublon', 62)])],
      },
      {
        window: { index: 1, startMs: 60_000, endMs: 120_000 },
        // Relative times: 61 s and 62 s on the lecture clock are 1 s and 2 s here.
        segments: [segment([word('milieu', 1), word('doublon', 2), word('après', 10)])],
      },
    ]);
    const texts = stitched.flatMap((s) => s.words.map((w) => `${w.text}@${w.start}`));
    expect(texts).toEqual(['avant@59', 'milieu@61', 'doublon@62', 'après@70']);
  });

  it('decides by segment start for an engine with no words', () => {
    const stitched = stitchWindows([
      {
        window: { index: 0, startMs: 0, endMs: 603_000 },
        segments: [
          { start: 590, end: 600, text: 'kept from the first', words: [] },
          { start: 601, end: 603, text: 'duplicate', words: [] },
        ],
      },
      {
        window: { index: 1, startMs: 600_000, endMs: 700_000 },
        segments: [
          { start: 0.5, end: 1, text: 'lost to the first', words: [] },
          { start: 1.5, end: 3, text: 'duplicate', words: [] },
        ],
      },
    ]);
    // The second window cut the overlap differently; its copy ends inside
    // what the first already covered, so it is a repeat.
    expect(stitched.map((s) => [s.text, s.start])).toEqual([
      ['kept from the first', 590],
      ['duplicate', 601],
    ]);
  });

  it('keeps a segment that runs past covered ground rather than lose its tail', () => {
    const stitched = stitchWindows([
      {
        window: { index: 0, startMs: 0, endMs: 603_000 },
        segments: [{ start: 598, end: 603, text: 'first', words: [] }],
      },
      {
        window: { index: 1, startMs: 600_000, endMs: 700_000 },
        segments: [{ start: 1.6, end: 6, text: 'second, longer', words: [] }],
      },
    ]);
    expect(stitched.map((s) => s.text)).toEqual(['first', 'second, longer']);
  });

  it('survives an empty window and windows given out of order', () => {
    const stitched = stitchWindows([
      { window: { index: 1, startMs: 10_000, endMs: 20_000 }, segments: [] },
      {
        window: { index: 0, startMs: 0, endMs: 13_000 },
        segments: [segment([word('seul', 1)])],
      },
    ]);
    expect(stitched).toHaveLength(1);
    expect(stitched[0]!.text).toBe('seul');
  });
});

describe('groupParagraphs', () => {
  it('breaks where a sentence ends and the speaker pauses', () => {
    const paragraphs = groupParagraphs([
      segment([word('Bonjour.', 0), word('Aujourd’hui', 0.5)]),
      segment([word('photosynthèse.', 1)]),
      // 1.3 → 4.0 is a pause of 2.7 s after a full stop.
      segment([word('Ensuite', 4), word('Calvin.', 4.5)]),
    ]);
    expect(paragraphs.map((p) => p.words.map((w) => w.text).join(' '))).toEqual([
      'Bonjour. Aujourd’hui photosynthèse.',
      'Ensuite Calvin.',
    ]);
    expect(paragraphs[1]!.startMs).toBe(4_000);
  });

  it('does not break a pause mid-sentence, but does after thirty seconds of speech', () => {
    const words = Array.from({ length: 40 }, (_, i) =>
      word(i % 10 === 9 ? 'fin.' : 'mot', i),
    );
    words.splice(5, 0, word('hésitation', 5.2)); // no full stop before the gap
    const paragraphs = groupParagraphs([segment(words)]);
    expect(paragraphs[0]!.words.map((w) => w.text)).toContain('hésitation');
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(paragraphs[0]!.endMs - paragraphs[0]!.startMs).toBeLessThan(45_000);
  });

  it('never lets an unpunctuated transcript become one wall', () => {
    const words = Array.from({ length: 200 }, (_, i) => word('mot', i));
    const paragraphs = groupParagraphs([segment(words)]);
    for (const paragraph of paragraphs) {
      expect(paragraph.endMs - paragraph.startMs).toBeLessThanOrEqual(45_300);
    }
  });
});

describe('transcriptBlocks', () => {
  it('anchors every paragraph to the recording at its start', () => {
    const { blocks } = transcriptBlocks(
      groupParagraphs([segment([word('Bonjour.', 12)])]),
      'rec-1',
    );
    expect(blocks[0]!.attrs).toEqual({
      audioAnchor: { recordingId: 'rec-1', offsetMs: 12_000 },
    });
    expect(blocks[0]!.content).toEqual([{ type: 'text', text: 'Bonjour.' }]);
  });

  it('highlights a run of doubtful words as one passage, and never a missing confidence', () => {
    const { blocks, passages } = transcriptBlocks(
      groupParagraphs([
        segment([
          word('le', 0),
          word('sique', 0.3, 0.3),
          word('le', 0.6, 0.12),
          word('de', 0.9),
          word('Calvin', 1.2, null),
        ]),
      ]),
      'rec-1',
    );
    expect(passages).toBe(1);
    expect(blocks[0]!.content).toEqual([
      { type: 'text', text: 'le ' },
      {
        type: 'text',
        text: 'sique le',
        marks: [{ type: 'highlight', attrs: { color: 'var(--nb-mark)' } }],
      },
      { type: 'text', text: ' de Calvin' },
    ]);
  });
});
