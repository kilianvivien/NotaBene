import { describe, expect, it } from 'vitest';
import { deriveTitle, docHasFeature, docStats, flattenDoc } from './docText';
import type { NoteDoc } from '@/lib/schema';

const doc: NoteDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Limits' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'A limit describes ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'approach' },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'math', attrs: { latex: '\\lim_{x \\to 0}' } },
    { type: 'image', attrs: { assetId: 'abc', caption: 'Epsilon-delta diagram' } },
  ],
};

describe('flattenDoc', () => {
  it('joins inline runs and breaks between blocks', () => {
    expect(flattenDoc(doc)).toBe(
      'Limits\nA limit describes approach.\n\\lim_{x \\to 0}Epsilon-delta diagram',
    );
  });

  it('includes LaTeX so formulas are searchable', () => {
    expect(flattenDoc(doc)).toContain('\\lim_{x \\to 0}');
  });

  it('includes image captions', () => {
    expect(flattenDoc(doc)).toContain('Epsilon-delta diagram');
  });
});

describe('docHasFeature', () => {
  it('finds nested nodes', () => {
    const nested: NoteDoc = {
      type: 'doc',
      content: [
        { type: 'callout', content: [{ type: 'table', content: [] }] },
      ],
    };
    expect(docHasFeature(nested, 'table')).toBe(true);
    expect(docHasFeature(nested, 'drawing')).toBe(false);
  });

  it('treats both drawing node names as drawings', () => {
    const drawing: NoteDoc = { type: 'doc', content: [{ type: 'excalidraw' }] };
    expect(docHasFeature(drawing, 'drawing')).toBe(true);
  });
});

describe('deriveTitle', () => {
  it('borrows the first line when the student never titled the note', () => {
    expect(deriveTitle(doc, 'Untitled')).toBe('Limits');
  });

  it('falls back when the document is empty', () => {
    expect(deriveTitle({ type: 'doc', content: [] }, 'Untitled')).toBe('Untitled');
  });
});

describe('docStats', () => {
  it('counts words and estimates reading time', () => {
    const stats = docStats(doc);
    expect(stats.words).toBeGreaterThan(0);
    expect(stats.readingMinutes).toBeGreaterThanOrEqual(1);
  });
});
