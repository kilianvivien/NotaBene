/**
 * Word completion inside a real editor.
 *
 * Most of what is asserted here is what the feature must *not* do: take Tab
 * from a list with nothing on screen, write anything the student did not
 * accept, fire during composition or in code, or look like an edit to
 * autosave. Those are the ways a completer degrades the editor around it.
 */
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Abbreviation } from '@/lib/adapters';
import {
  buildCompletionIndex,
  type CompletionIndex,
} from '@/lib/vocabulary/completionIndex';
import { editorExtensions } from '.';
import { currentCompletion, wordCompletionPluginKey } from './WordCompletion';

const INDEX: CompletionIndex = buildCompletionIndex(
  [],
  [
    { term: 'mitochondrie', status: 'accepted' },
    { term: 'théorème', status: 'accepted' },
    { term: 'Schrödinger', status: 'accepted' },
  ],
);

let editor: Editor | undefined;
let enabled = true;
let triggers: Abbreviation[] = [];

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  enabled = true;
  triggers = [];
});

function open(html: string): Editor {
  editor = new Editor({
    extensions: editorExtensions('Write…', () => triggers, undefined, {
      resolve: () => INDEX,
      settings: () => ({ enabled, minPrefix: 3 }),
      triggers: () => triggers,
    }),
    content: html,
  });
  return editor;
}

/** Type as the keyboard does: one text insertion per character, at the caret. */
function type(current: Editor, text: string): void {
  for (const character of text) {
    current.view.dispatch(current.state.tr.insertText(character));
  }
}

function press(current: Editor, key: string): { handled: boolean; stopped: boolean } {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  let stopped = false;
  const stop = event.stopPropagation.bind(event);
  event.stopPropagation = () => {
    stopped = true;
    stop();
  };
  const handled =
    current.view.someProp('handleKeyDown', (handler) => handler(current.view, event)) ??
    false;
  return { handled, stopped };
}

function caretAtEnd(current: Editor): void {
  current.commands.setTextSelection(current.state.doc.content.size - 1);
}

function text(current: Editor): string {
  return current.state.doc.textContent;
}

describe('word completion', () => {
  it('draws the rest of the word after the caret without writing it', () => {
    const current = open('<p></p>');
    type(current, 'La mito');

    expect(currentCompletion(current.state)?.rest).toBe('chondrie');
    expect(current.view.dom.querySelector('.nb-completion-ghost')?.textContent).toBe(
      'chondrie',
    );
    // The document holds only what was typed: nothing for autosave, export
    // or an agent to pick up.
    expect(text(current)).toBe('La mito');
    expect(JSON.stringify(current.getJSON())).not.toContain('chondrie');
  });

  it('accepts with Tab as one undoable edit', () => {
    const current = open('<p></p>');
    type(current, 'La mito');

    expect(press(current, 'Tab').handled).toBe(true);
    expect(text(current)).toBe('La mitochondrie');
    expect(currentCompletion(current.state)).toBeNull();

    current.commands.undo();
    expect(text(current)).toBe('La mito');
  });

  it('puts back the accents the student skipped', () => {
    const current = open('<p></p>');
    type(current, 'theor');
    press(current, 'Tab');
    expect(text(current)).toBe('théorème');
  });

  it('follows a capital typed at the start of a sentence', () => {
    const current = open('<p></p>');
    type(current, 'Mito');
    expect(currentCompletion(current.state)?.term).toBe('Mitochondrie');
  });

  it('leaves Tab to the list when nothing is suggested', () => {
    const current = open('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
    caretAtEnd(current);
    expect(currentCompletion(current.state)).toBeNull();

    expect(press(current, 'Tab').handled).toBe(true);
    // The second item sank under the first, exactly as without the feature.
    const list = current.getJSON().content?.[0];
    expect(list?.content).toHaveLength(1);
    expect(JSON.stringify(list)).toContain('"bulletList"');
    expect(text(current)).toBe('onetwo');
  });

  it('dismisses with Escape, keeps Escape from leaving focus mode, and stays dismissed for the word', () => {
    const current = open('<p></p>');
    type(current, 'mito');
    const updates: number[] = [];
    current.on('update', () => updates.push(1));

    const escape = press(current, 'Escape');
    expect(escape.handled).toBe(true);
    expect(escape.stopped).toBe(true);
    expect(currentCompletion(current.state)).toBeNull();
    // Dismissing is not an edit.
    expect(updates).toHaveLength(0);

    type(current, 'c');
    expect(currentCompletion(current.state)).toBeNull();

    type(current, ' theo');
    expect(currentCompletion(current.state)?.term).toBe('théorème');
  });

  it('lets Escape through when nothing is suggested', () => {
    const current = open('<p>plain</p>');
    expect(press(current, 'Escape').stopped).toBe(false);
  });

  it('shows nothing when the caret is moved into a word rather than typed', () => {
    const current = open('<p>mito and more</p>');
    current.commands.setTextSelection(5);
    expect(currentCompletion(current.state)).toBeNull();
  });

  it('shows nothing in the middle of a word', () => {
    const current = open('<p>chondrie</p>');
    current.commands.setTextSelection(1);
    type(current, 'mito');
    expect(currentCompletion(current.state)).toBeNull();
  });

  it('stays out of code, the slash menu and the link menu', () => {
    const code = open('<pre><code></code></pre>');
    type(code, 'mito');
    expect(currentCompletion(code.state)).toBeNull();
    code.destroy();

    const slash = open('<p></p>');
    type(slash, '/mito');
    expect(currentCompletion(slash.state)).toBeNull();
    slash.destroy();

    const link = open('<p></p>');
    type(link, '[[mito');
    expect(currentCompletion(link.state)).toBeNull();
  });

  it('yields to an abbreviation with the same trigger', () => {
    triggers = [{ id: 'a', trigger: 'mito', expansion: 'mitochondrial' }];
    const current = open('<p></p>');
    type(current, 'mito');
    expect(currentCompletion(current.state)).toBeNull();
  });

  it('ignores a paste, a remote rewrite, and a read-only note', () => {
    const current = open('<p></p>');
    current.view.dispatch(
      current.state.tr.insertText('mito').setMeta('uiEvent', 'paste'),
    );
    expect(currentCompletion(current.state)).toBeNull();

    current.commands.clearContent();
    type(current, 'mito');
    expect(currentCompletion(current.state)).not.toBeNull();
    // An agent's write replaces the document; whatever was suggested goes.
    current.commands.setContent('<p>Rewritten by an agent</p>');
    expect(currentCompletion(current.state)).toBeNull();

    current.setEditable(false, false);
    current.commands.setContent('<p></p>');
    type(current, 'mito');
    expect(currentCompletion(current.state)).toBeNull();
  });

  it('stands aside while text is being composed', () => {
    const current = open('<p></p>');
    const plugin = current.state.plugins.find(
      (entry) => entry.spec.key === wordCompletionPluginKey,
    );
    plugin?.props.handleDOMEvents?.compositionstart?.call(
      plugin,
      current.view,
      new Event('compositionstart') as CompositionEvent,
    );
    type(current, 'mito');
    expect(currentCompletion(current.state)).toBeNull();

    plugin?.props.handleDOMEvents?.compositionend?.call(
      plugin,
      current.view,
      new Event('compositionend') as CompositionEvent,
    );
    type(current, 'c');
    expect(currentCompletion(current.state)?.term).toBe('mitochondrie');
  });

  it('does nothing when switched off', () => {
    enabled = false;
    const current = open('<p></p>');
    type(current, 'mito');
    expect(currentCompletion(current.state)).toBeNull();
    expect(press(current, 'Tab').handled).toBe(false);
  });
});
