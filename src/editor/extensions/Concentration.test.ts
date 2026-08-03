import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DecorationSet } from '@tiptap/pm/view';
import { focusedBlock, type ConcentrationState } from './Concentration';
import { editorExtensions } from '.';

const ON: ConcentrationState = {
  active: true,
  lineFocus: 'paragraph',
  blockCaret: true,
  typewriterScrolling: true,
};

let editor: Editor | undefined;
let config: ConcentrationState = ON;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  config = ON;
});

function open(html: string): Editor {
  editor = new Editor({
    extensions: editorExtensions(
      'Write…',
      () => [],
      () => config,
    ),
    content: html,
  });
  return editor;
}

/**
 * The decorations the plugin is contributing for the current selection.
 *
 * A node decoration keeps its class on `type.attrs`, while a widget keeps its
 * options on `spec` — so both are surfaced here rather than guessing which one
 * a given assertion means.
 */
function decorations(
  current: Editor,
): { from: number; to: number; spec: unknown; attrs: unknown }[] {
  const sets = current.view.someProp('decorations', (handler) =>
    handler.call(
      current.view.state.plugins.find((plugin) =>
        String(plugin.spec.key).startsWith('concentration'),
      ),
      current.view.state,
    ),
  );
  if (!(sets instanceof DecorationSet)) return [];
  return sets.find().map((decoration) => ({
    from: decoration.from,
    to: decoration.to,
    spec: decoration.spec,
    attrs: (decoration as unknown as { type: { attrs?: unknown } }).type.attrs,
  }));
}

describe('concentration decorations', () => {
  it('marks the textblock holding the cursor, not the block that contains it', () => {
    const current = open('<ul><li><p>first</p></li><li><p>second</p></li></ul>');
    const inSecond = current.state.doc.content.size - 4;
    current.commands.setTextSelection(inSecond);

    const block = focusedBlock(current.state);
    expect(block).not.toBeNull();
    // The paragraph inside the list item is the line being written; resolving
    // to the list would dim nothing in a page of bulleted notes.
    expect(current.state.doc.resolve(block!.from + 1).parent.type.name).toBe('paragraph');
    expect(current.state.doc.textBetween(block!.from, block!.to, ' ', ' ').trim()).toBe(
      'second',
    );
  });

  it('decorates the focused line and places a block caret', () => {
    const current = open('<p>alpha</p><p>beta</p>');
    current.commands.setTextSelection(3);

    const found = decorations(current);
    const line = found.find(
      (entry) =>
        (entry.attrs as { class?: string } | undefined)?.class === 'nb-focus-line',
    );
    const caret = found.find(
      (entry) => (entry.spec as { key?: string }).key === 'nb-block-caret',
    );

    expect(line).toBeDefined();
    // The first paragraph, not the second: the decoration follows the cursor.
    expect(current.state.doc.textBetween(line!.from, line!.to, ' ', ' ').trim()).toBe(
      'alpha',
    );
    expect(caret?.from).toBe(3);
  });

  it('contributes nothing while concentration mode is off', () => {
    config = { ...ON, active: false };
    const current = open('<p>alpha</p>');
    current.commands.setTextSelection(2);

    expect(decorations(current)).toEqual([]);
  });

  it('drops the line decoration when line focus is off, keeping the caret', () => {
    config = { ...ON, lineFocus: 'off' };
    const current = open('<p>alpha</p>');
    current.commands.setTextSelection(2);

    expect(decorations(current)).toHaveLength(1);
  });

  it('hides the block caret while text is selected', () => {
    config = { ...ON, lineFocus: 'off' };
    const current = open('<p>alpha</p>');
    current.commands.setTextSelection({ from: 1, to: 4 });

    expect(decorations(current)).toEqual([]);
  });
});
