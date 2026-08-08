import { describe, expect, it } from 'vitest';
import { demoteHeadings, mergeNoteDocs } from './mergeDocs';
import type { DocNode, NoteDoc } from '@/lib/schema';

const OPTIONS = { untitledLabel: 'Untitled note' };

function doc(...content: DocNode[]): NoteDoc {
  return { type: 'doc', content };
}

function heading(level: number, text: string): DocNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function paragraph(text: string): DocNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

describe('mergeNoteDocs', () => {
  it('keeps the given order and titles each source', () => {
    const merged = mergeNoteDocs(
      [
        { title: 'Second lecture', doc: doc(paragraph('b')) },
        { title: 'First lecture', doc: doc(paragraph('a')) },
      ],
      OPTIONS,
    );

    const titles = merged.content
      .filter((node) => node.type === 'heading')
      .map((node) => node.content?.[0]?.text);
    expect(titles).toEqual(['Second lecture', 'First lecture']);
  });

  it('separates sources with a rule, but does not open with one', () => {
    const merged = mergeNoteDocs(
      [
        { title: 'A', doc: doc(paragraph('a')) },
        { title: 'B', doc: doc(paragraph('b')) },
        { title: 'C', doc: doc(paragraph('c')) },
      ],
      OPTIONS,
    );

    expect(merged.content[0]?.type).toBe('heading');
    expect(merged.content.filter((node) => node.type === 'horizontalRule')).toHaveLength(2);
  });

  it('falls back to the untitled label rather than an empty heading', () => {
    const merged = mergeNoteDocs(
      [
        { title: '   ', doc: doc(paragraph('a')) },
        { title: 'B', doc: doc(paragraph('b')) },
      ],
      OPTIONS,
    );
    expect(merged.content[0]?.content?.[0]?.text).toBe('Untitled note');
  });

  it('never produces an empty document', () => {
    const merged = mergeNoteDocs(
      [
        { title: '', doc: doc() },
        { title: '', doc: doc() },
      ],
      OPTIONS,
    );
    expect(merged.content.length).toBeGreaterThan(0);
  });

  it('pushes the sources own headings below the title it adds', () => {
    const merged = mergeNoteDocs(
      [{ title: 'Lecture', doc: doc(heading(1, 'Intro'), paragraph('a')) }],
      OPTIONS,
    );

    expect(merged.content[0]?.attrs?.level).toBe(1);
    expect(merged.content[1]?.attrs?.level).toBe(2);
  });
});

describe('demoteHeadings', () => {
  it('leaves everything that is not a heading alone', () => {
    const node = paragraph('a');
    expect(demoteHeadings(node)).toEqual(node);
  });

  it('stops at level 6 rather than inventing a level 7', () => {
    expect(demoteHeadings(heading(6, 'deep')).attrs?.level).toBe(6);
    expect(demoteHeadings(heading(5, 'deep')).attrs?.level).toBe(6);
  });

  it('reaches headings nested inside other blocks', () => {
    const callout: DocNode = {
      type: 'callout',
      attrs: { kind: 'info' },
      content: [heading(2, 'Watch out'), paragraph('a')],
    };
    const demoted = demoteHeadings(callout);
    expect(demoted.content?.[0]?.attrs?.level).toBe(3);
    expect(demoted.content?.[1]).toEqual(paragraph('a'));
  });

  it('treats a heading with no level as level 1', () => {
    expect(demoteHeadings({ type: 'heading' }).attrs?.level).toBe(2);
  });
});
