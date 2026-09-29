import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  applySelectionText,
  selectionTarget,
  textSlice,
  wordRangeAt,
} from './selectionTarget';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup() {
  editor = new Editor({
    extensions: [StarterKit],
    content: '<p>Before selected after</p><p>Unchanged</p>',
  });
  editor.commands.setTextSelection({ from: 8, to: 16 });
  return editor;
}
describe('selection-scoped editing', () => {
  it('preserves a space selected with a word', () => {
    setup();
    editor.commands.setTextSelection({ from: 8, to: 17 });
    expect(applySelectionText(editor, selectionTarget(editor)!, 'improved')).toBe(true);
    expect(editor.getText()).toBe('Before improved after\n\nUnchanged');
  });
  it('does not add empty paragraphs between the model’s paragraphs', () => {
    setup();
    editor.commands.selectAll();
    expect(applySelectionText(editor, selectionTarget(editor)!, 'First\n\nSecond')).toBe(
      true,
    );
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.getText()).toBe('First\n\nSecond');
  });
  it('supports Select All and keeps the resulting document valid', () => {
    setup();
    editor.commands.selectAll();
    const target = selectionTarget(editor)!;
    expect(target.text).toBe('Before selected after\n\nUnchanged');
    expect(applySelectionText(editor, target, 'Rewritten')).toBe(true);
    expect(editor.getText()).toBe('Rewritten');
    expect(() => editor.state.doc.check()).not.toThrow();
  });
  it('replaces only the captured range and undoes in one step', () => {
    setup();
    const before = editor.getJSON();
    const target = selectionTarget(editor)!;
    expect(target.text).toBe('selected');
    expect(applySelectionText(editor, target, 'improved')).toBe(true);
    expect(editor.getText()).toBe('Before improved after\n\nUnchanged');
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });
  it('refuses a result after any edit to the source document', () => {
    setup();
    const target = selectionTarget(editor)!;
    editor.commands.insertContent('changed');
    const before = editor.getJSON();
    expect(applySelectionText(editor, target, 'stale')).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
  it('handles text spanning paragraphs without changing surrounding text', () => {
    setup();
    editor.commands.setTextSelection({ from: 8, to: 25 });
    const target = selectionTarget(editor)!;
    expect(applySelectionText(editor, target, 'one\ntwo')).toBe(true);
    expect(editor.getText()).toBe('Before one\n\ntwonchanged');
  });
  it('pastes literal HTML as text', () => {
    setup();
    editor.view.dispatch(
      editor.state.tr.replaceSelection(textSlice(editor, '<b>literal</b>')),
    );
    expect(editor.getText()).toContain('<b>literal</b>');
    expect(editor.getHTML()).toContain('&lt;b&gt;literal&lt;/b&gt;');
  });
  it('refuses empty, oversized, and read-only apply targets', () => {
    setup();
    editor.commands.setTextSelection(1);
    expect(selectionTarget(editor)).toBeNull();
    editor.commands.setContent('<p>' + 'x'.repeat(4001) + '</p>');
    editor.commands.selectAll();
    expect(selectionTarget(editor)).toBeNull();
    editor.destroy();
    setup();
    const target = selectionTarget(editor)!;
    editor.setEditable(false);
    expect(applySelectionText(editor, target, 'no')).toBe(false);
  });
});

describe('context-click word selection', () => {
  function wordAt(html: string, pos: number): string | null {
    editor = new Editor({ extensions: [StarterKit], content: html });
    const range = wordRangeAt(editor.state.doc, pos);
    return range ? editor.state.doc.textBetween(range.from, range.to) : null;
  }

  it('selects the word under the click, joiners included', () => {
    // <p> opens at 0, so text offset n is position n + 1.
    expect(wordAt('<p>le laissez-faire d’État</p>', 8)).toBe('laissez-faire');
    expect(wordAt('<p>le laissez-faire d’État</p>', 22)).toBe('d’État');
  });

  it('drops quotes and dashes at the edges', () => {
    expect(wordAt("<p>'cellule' -mitose</p>", 4)).toBe('cellule');
    expect(wordAt("<p>'cellule' -mitose</p>", 16)).toBe('mitose');
  });

  it('finds the word across marks and returns nothing in spaces', () => {
    expect(wordAt('<p>une <strong>cel</strong>lule</p>', 7)).toBe('cellule');
    expect(wordAt('<p>a , b</p>', 4)).toBeNull();
  });

  it('keeps a caret in code', () => {
    expect(wordAt('<pre><code>const value</code></pre>', 3)).toBeNull();
  });
});
