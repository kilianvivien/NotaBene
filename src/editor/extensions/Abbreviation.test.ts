import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createAbbreviation } from '@/lib/notes/abbreviations';
import { abbreviationPluginKey } from './Abbreviation';
import { editorExtensions } from '.';

const rules = [
  createAbbreviation('thm', 'theorem'),
  createAbbreviation('nb', 'nota bene'),
];

let editor: Editor | undefined;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function open(html: string): Editor {
  editor = new Editor({
    extensions: editorExtensions('Write…', () => rules),
    content: html,
  });
  return editor;
}

/** What the browser does when a character is typed at the cursor. */
function type(current: Editor, text: string): boolean {
  const { from, to } = current.state.selection;
  const handled =
    current.view.someProp('handleTextInput', (handler) =>
      handler(current.view, from, to, text, () =>
        current.state.tr.insertText(text, from, to),
      ),
    ) ?? false;
  if (!handled) current.commands.insertContent(text);
  return handled;
}

describe('abbreviation expansion', () => {
  it('expands a trigger when the word is finished', () => {
    const current = open('<p>the fundamental thm</p>');
    current.commands.setTextSelection(current.state.doc.content.size - 1);
    type(current, ' ');

    expect(current.getText()).toBe('the fundamental theorem ');
  });

  it('expands on Enter, leaving the break to the editor', () => {
    const current = open('<p>nb</p>');
    current.commands.setTextSelection(current.state.doc.content.size - 1);
    current.view.someProp('handleKeyDown', (handler) =>
      handler(current.view, new KeyboardEvent('keydown', { key: 'Enter' })),
    );

    // The keymap that splits the block runs after us, against the expanded text.
    expect(current.state.doc.firstChild?.textContent).toBe('nota bene');
    expect(current.state.doc.childCount).toBe(2);
  });

  it('leaves the trigger alone mid-word and inside code', () => {
    const current = open('<p>algorithm</p>');
    current.commands.setTextSelection(current.state.doc.content.size - 1);
    type(current, '.');
    expect(current.getText()).toBe('algorithm.');

    const code = open('<pre><code>thm</code></pre>');
    code.commands.setTextSelection(code.state.doc.content.size - 1);
    expect(type(code, ' ')).toBe(false);
    expect(code.state.doc.firstChild?.textContent).toBe('thm ');
  });

  it('expands when several characters arrive in one input event', () => {
    const current = open('<p>the fundamental t</p>');
    current.commands.setTextSelection(current.state.doc.content.size - 1);
    expect(type(current, 'hm ')).toBe(true);

    expect(current.getText()).toBe('the fundamental theorem ');
  });

  it('marks the words it wrote, and takes the mark off again', async () => {
    const current = open('<p>nb</p>');
    current.commands.setTextSelection(current.state.doc.content.size - 1);
    type(current, ' ');

    const flashed = () =>
      abbreviationPluginKey.getState(current.state)?.find().length ?? 0;
    expect(flashed()).toBe(1);
    expect(current.view.dom.querySelector('.nb-abbr-flash')?.textContent).toBe(
      'nota bene',
    );

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(flashed()).toBe(0);
  });

  it('does nothing when no abbreviations are configured', () => {
    editor = new Editor({
      extensions: editorExtensions('Write…'),
      content: '<p>thm</p>',
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    type(editor, ' ');

    expect(editor.getText()).toBe('thm ');
  });
});
