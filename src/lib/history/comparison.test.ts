import { describe, expect, it } from 'vitest';
import { compareDocuments, documentOutline } from './comparison';
import type { NoteDoc } from '@/lib/schema';

const saved: NoteDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Shared section' }],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Removed section' }],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Short text' }] },
  ],
};

const current: NoteDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Shared section' }],
    },
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Added section' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'This version contains considerably more text' }],
    },
  ],
};

describe('version comparison', () => {
  it('extracts the document outline without full body text', () => {
    expect(documentOutline(saved)).toEqual([
      { level: 2, text: 'Shared section' },
      { level: 2, text: 'Removed section' },
    ]);
  });

  it('summarizes size and section changes', () => {
    const comparison = compareDocuments(saved, current);
    expect(comparison.delta.words).toBeGreaterThan(0);
    expect(comparison.outline).toEqual([
      { level: 2, text: 'Shared section', status: 'unchanged' },
      { level: 3, text: 'Added section', status: 'added' },
      { level: 2, text: 'Removed section', status: 'removed' },
    ]);
  });
});
