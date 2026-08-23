import { describe, expect, it } from 'vitest';
import type { NoteDoc } from '@/lib/schema';
import {
  documentOutline,
  moveOutlineSection,
  setWritingTarget,
  writingProgress,
} from './outline';

const doc: NoteDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'one two three' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Child' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'four five' }] },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Two' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'six seven' }] },
  ],
};

describe('long-form document outline', () => {
  it('derives nested section ranges and word counts', () => {
    expect(documentOutline(doc)).toMatchObject([
      { index: 0, end: 4, level: 1, words: 6 },
      { index: 2, end: 4, level: 2, words: 2 },
      { index: 4, end: 6, level: 1, words: 2 },
    ]);
  });

  it('moves a heading with its descendants and body', () => {
    const moved = moveOutlineSection(doc, 0, 4);
    expect(documentOutline(moved).map((entry) => entry.title)).toEqual([
      'Two',
      'One',
      'Child',
    ]);
    expect(moved.content[1]?.content?.[0]?.text).toBe('six seven');
  });

  it('stores note and section targets in document attributes', () => {
    const noteTarget = setWritingTarget(doc, 20);
    expect(writingProgress(noteTarget)).toEqual({
      words: 10,
      target: 20,
      source: 'note',
    });

    const sectionTarget = setWritingTarget(doc, 5, 2);
    expect(writingProgress(sectionTarget)).toEqual({
      words: 2,
      target: 5,
      source: 'sections',
    });
  });
});
