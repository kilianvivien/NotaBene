import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '.';

describe('editor Markdown', () => {
  it('round-trips the Phase B block vocabulary', () => {
    const markdown = [
      '# Lecture',
      '',
      'A **bold** idea with $x^2$ and [[Limits|note_limits]].',
      '',
      '> [!IMPORTANT]',
      '> Learn this for the exam.',
      '',
      '> [!TOGGLE Proof]',
      '> Hidden derivation.',
      '',
      '- [x] Read chapter',
      '- [ ] Solve exercises',
      '',
      '| Concept | Meaning |',
      '| --- | --- |',
      '| Limit | Approach |',
      '',
      '$$',
      '\\lim_{x\\to 0} x = 0',
      '$$',
    ].join('\n');

    const parsed = markdownToDoc(markdown);
    const reparsed = markdownToDoc(docToMarkdown(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it('preserves editable drawing data and its cached SVG', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        {
          type: 'drawing',
          attrs: {
            data: { elements: [{ id: 'shape' }], appState: {}, files: {} },
            svg: '<svg></svg>',
            title: 'Diagram',
          },
        },
      ],
    };
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });
});
