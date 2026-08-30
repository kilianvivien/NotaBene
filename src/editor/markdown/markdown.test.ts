import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '.';

describe('editor Markdown', () => {
  it('round-trips footnotes and endnotes without flattening their semantics', () => {
    const markdown =
      'Claim[^fn-1] and coda[^en-1].\n\n[^fn-1]: Source note\n[^en-1]: Closing note';
    const parsed = markdownToDoc(markdown);
    const references = parsed.content[0]?.content?.filter(
      (node) => node.type === 'footnote',
    );
    expect(references?.map((node) => node.attrs)).toEqual([
      { id: 'fn-1', kind: 'footnote', note: 'Source note' },
      { id: 'en-1', kind: 'endnote', note: 'Closing note' },
    ]);
    expect(docToMarkdown(parsed)).toBe(markdown);
  });

  /**
   * Inserting the task-chip alternative into the inline pattern shifted every
   * capture group after it, so this pins the whole inline vocabulary rather
   * than the chip alone — a silent off-by-two would turn bold into italics.
   */
  it('round-trips the inline vocabulary, including a task chip', () => {
    const markdown =
      'A **bold** and *slanted* idea with `code`, ==marked==, $x^2$, ' +
      '[a link](https://example.com), [[Limits|note_limits]] and ' +
      '[task:task_1|Problem set 3].';

    const parsed = markdownToDoc(markdown);
    const inline = parsed.content[0]?.content ?? [];

    expect(inline.find((node) => node.type === 'taskRef')?.attrs).toEqual({
      taskId: 'task_1',
      label: 'Problem set 3',
    });
    expect(inline.find((node) => node.type === 'wikiLink')?.attrs).toEqual({
      title: 'Limits',
      noteId: 'note_limits',
    });
    expect(inline.find((node) => node.type === 'math')?.attrs).toEqual({ latex: 'x^2' });
    const marksOf = (value: string) =>
      inline.find((node) => node.text === value)?.marks?.map((mark) => mark.type);
    expect(marksOf('bold')).toEqual(['bold']);
    expect(marksOf('slanted')).toEqual(['italic']);
    expect(marksOf('code')).toEqual(['code']);
    expect(marksOf('marked')).toEqual(['highlight']);
    expect(marksOf('a link')).toEqual(['link']);

    expect(docToMarkdown(parsed)).toBe(markdown);
  });

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
  /**
   * AnyDoc 0.2 renders `Inline::Checkbox` as `[x]`, which reaches a table cell
   * as `| [x] | [ ] Wall |`. The task branch requires a leading bullet, so a
   * spreadsheet's checkbox column must stay a table rather than becoming a
   * task list -- and a genuine bulleted checkbox must still become one.
   */
  it('reads a checkbox as a task only where a bullet makes it one', () => {
    const table = markdownToDoc('| A | B |\n| --- | --- |\n| [x] | [ ] Wall |');
    expect(table.content.some((node) => node.type === 'taskList')).toBe(false);

    const list = markdownToDoc('- [x] done\n- [ ] todo');
    const tasks = list.content.find((node) => node.type === 'taskList');
    expect(tasks?.content?.map((item) => item.attrs?.checked)).toEqual([true, false]);
  });
  /**
   * Widening the divider to accept a single column risked turning any
   * paragraph that happens to contain a pipe into a table as soon as a
   * horizontal rule followed it. Both outer pipes are required to stop that.
   */
  it('does not read a horizontal rule as a table divider', () => {
    const doc = markdownToDoc('Use the | key\n\n---');
    expect(doc.content.map((node) => node.type)).toEqual(['paragraph', 'horizontalRule']);

    const table = markdownToDoc('| Mark |\n| --- |\n| 91 |');
    expect(table.content[0]?.type).toBe('table');
  });
});
