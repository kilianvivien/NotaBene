import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createDictationWriter } from './dictationWriter';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup() {
  editor = new Editor({ extensions: [StarterKit], content: '<p>Before after</p>' });
  editor.commands.setTextSelection(8);
  return createDictationWriter(editor, 'note-1')!;
}

describe('dictation insertion point', () => {
  it('appends provider deltas verbatim at the original caret after the student moves it', () => {
    const writer = setup();
    expect(writer.append('Bonjour')).toBe(true);
    editor.commands.setTextSelection(1);
    expect(writer.append(' le monde.')).toBe(true);
    expect(editor.getText()).toBe('Before Bonjour le monde.after');
    expect(editor.state.selection.from).toBe(1);
    writer.close();
    expect(writer.append('no')).toBe(false);
  });

  it('maps the insertion point through concurrent typing before it', () => {
    const writer = setup();
    editor.commands.insertContentAt(1, 'Typed ');
    writer.append('Spoken ');
    expect(editor.getText()).toBe('Typed Before Spoken after');
    writer.close();
  });

  it('preserves line breaks and refuses to insert after its target was deleted', () => {
    const writer = setup();
    writer.append('One\nTwo');
    expect(
      editor.getJSON().content?.[0]?.content?.some((node) => node.type === 'hardBreak'),
    ).toBe(true);
    editor.commands.setContent('<p>Replacement</p>');
    expect(writer.append('must not appear')).toBe(false);
    expect(editor.getText()).toBe('Replacement');
    writer.close();
  });
});
