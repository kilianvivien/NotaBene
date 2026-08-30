import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '@/editor/markdown';
import type { DocNode } from '@/lib/schema';

/**
 * The seam between `src-tauri/src/document_import/render.rs` and
 * `markdownToDoc`.
 *
 * The renderer's own tests assert the exact strings it produces, and the
 * parser's tests assert what it accepts, but nothing connected the two — so a
 * renderer change that stopped parsing would pass both suites. **Every string
 * below is copied verbatim from a golden assertion in `render.rs`.** If one
 * changes there and not here, this file is where it should break.
 */

function blocks(markdown: string): DocNode[] {
  return markdownToDoc(markdown).content;
}

function only(markdown: string): DocNode {
  const content = blocks(markdown);
  expect(content).toHaveLength(1);
  return content[0] as DocNode;
}

describe('what render.rs emits is what markdownToDoc accepts', () => {
  it('keeps a footnote a footnote and an endnote an endnote', () => {
    // render.rs: an_endnote_stays_an_endnote
    const doc = blocks('Claim[^fn-1] and coda[^en-1]\n\n[^fn-1]: Source note\n[^en-1]: Closing note');
    const notes = doc[0]?.content?.filter((node) => node.type === 'footnote');
    expect(notes?.map((node) => node.attrs)).toEqual([
      { id: 'fn-1', kind: 'footnote', note: 'Source note' },
      { id: 'en-1', kind: 'endnote', note: 'Closing note' },
    ]);
  });

  it('reads an embedded image as an image node carrying its placeholder', () => {
    // render.rs: an_embedded_image_lands_on_a_line_of_its_own
    const node = only('\n\n![Fig 1](asset:nb-import-3)\n\n');
    expect(node.type).toBe('image');
    expect(node.attrs?.assetId).toBe('nb-import-3');
    expect(node.attrs?.caption).toBe('Fig 1');
  });

  it('reads a headerless table as a table rather than a paragraph', () => {
    // render.rs: a_table_without_a_header_still_gets_a_divider
    const node = only('|  |  |\n| --- | --- |\n| Ada | 91 |');
    expect(node.type).toBe('table');
    expect(node.content).toHaveLength(2);
  });

  it('reads a header row as headers', () => {
    // render.rs: a_header_row_leads_and_the_divider_follows_it
    const node = only('| Student | Mark |\n| --- | --- |\n| Ada | 91 |');
    expect(node.content?.[0]?.content?.map((cell) => cell.type)).toEqual([
      'tableHeader',
      'tableHeader',
    ]);
  });

  /** The whole point of escaping the pipe: the row keeps its column count. */
  it('does not gain a column from a pipe in the words', () => {
    // render.rs: a_pipe_in_a_cell_does_not_split_the_row
    const node = only('| a \\| b |\n| --- |');
    const header = node.content?.[0]?.content;
    expect(header).toHaveLength(1);
    expect(header?.[0]?.content?.[0]?.content?.[0]?.text).toBe('a | b');
  });

  it('keeps a merged row aligned under its columns', () => {
    // render.rs: a_merged_cell_keeps_the_columns_aligned_and_says_so
    const node = only('| Term one |  |\n| --- | --- |\n| Jan | Feb |');
    expect(node.content?.map((row) => row.content?.length)).toEqual([2, 2]);
  });

  it('counts an ordered list from where the source did', () => {
    // render.rs: an_ordered_list_counts_from_where_the_source_did
    const node = only('4. four\n5. five');
    expect(node.type).toBe('orderedList');
    expect(node.attrs?.start).toBe(4);
    expect(node.content).toHaveLength(2);
  });

  it('reads a flattened nested list as one list, in order', () => {
    // render.rs: a_nested_list_flattens_and_says_so
    const node = only('- shallow\n- deep');
    expect(node.type).toBe('bulletList');
    expect(
      node.content?.map((item) => item.content?.[0]?.content?.[0]?.text),
    ).toEqual(['shallow', 'deep']);
  });

  it('reads a checkbox list as tasks', () => {
    // render.rs: a_checkbox_in_a_list_is_a_task_and_in_a_cell_is_text
    const node = only('- [x] done');
    expect(node.type).toBe('taskList');
    expect(node.content?.[0]?.attrs?.checked).toBe(true);
  });

  it('reads the marks the renderer chose', () => {
    // render.rs: code_beats_emphasis..., a_run_that_is_bold_and_italic...
    expect(only('`x = 1`').content?.[0]?.marks?.[0]?.type).toBe('code');
    expect(only('**both**').content?.[0]?.marks?.[0]?.type).toBe('bold');
  });

  it('keeps a percent-encoded bracket inside the link destination', () => {
    // render.rs: a_bracket_in_a_url_does_not_truncate_the_link
    const mark = only('[cite](https://x.test/a%28b%29c)').content?.[0]?.marks?.[0];
    expect(mark?.type).toBe('link');
    expect(mark?.attrs?.href).toBe('https://x.test/a%28b%29c');
  });

  it('reads both math delimiters', () => {
    // render.rs: math_reaches_both_of_the_dialects_delimiters
    expect(only('$e^{i\\pi}$').content?.[0]).toMatchObject({
      type: 'math',
      attrs: { latex: 'e^{i\\pi}' },
    });
    expect(only('$$\n\\int_0^1 x\n$$')).toMatchObject({
      type: 'mathBlock',
      attrs: { latex: '\\int_0^1 x' },
    });
  });

  it('clamps a deep heading rather than losing it', () => {
    // render.rs: a_heading_deeper_than_the_dialect_clamps_rather_than_vanishing
    expect(only('###### Deep')).toMatchObject({ type: 'heading', attrs: { level: 6 } });
  });

  /** The indent is what stops the body's own fence from closing the block. */
  it('keeps a fenced line inside the code block it belongs to', () => {
    // render.rs: a_fence_inside_a_code_block_cannot_close_it
    const node = only('```md\nbefore\n ```\nafter\n```');
    expect(node.type).toBe('codeBlock');
    expect(node.attrs?.language).toBe('md');
    expect(node.content?.[0]?.text).toBe('before\n ```\nafter');
  });
});
