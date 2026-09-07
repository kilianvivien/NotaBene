import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import type { DocNode, NoteDoc } from '@/lib/schema';
import { editorExtensions } from '../extensions';
import { definitionInsertPosition, wordAt } from './selectedTerm';

describe('wordAt', () => {
  it('finds the word the caret is inside', () => {
    expect(wordAt('un syllogisme valide', 6)).toBe('syllogisme');
  });

  /** The common case, and the one a forward-only scan gets wrong: the caret
   * sits after the last letter of a word that was just typed or double-clicked. */
  it('finds the word the caret sits at the end of', () => {
    expect(wordAt('un syllogisme valide', 13)).toBe('syllogisme');
  });

  it('keeps the joiners that live inside words', () => {
    expect(wordAt('le laissez-faire', 8)).toBe('laissez-faire');
    expect(wordAt('l’État de droit', 3)).toBe('l’État');
    expect(wordAt("l'État de droit", 3)).toBe("l'État");
  });

  it('reads a word with combining accents as one word', () => {
    // "e" plus U+0301, which is how text pasted out of some PDFs arrives.
    // Without \p{M} in the word class the scan stops at the accent and
    // "methode" is looked up as "thode".
    const decomposed = 'la me\u0301thode';
    expect(wordAt(decomposed, 5)).toBe('me\u0301thode');
    expect(wordAt(decomposed, 5).normalize('NFC')).toBe('m\u00e9thode');
  });

  it('returns nothing when the caret is not on a word', () => {
    expect(wordAt('un  syllogisme', 3)).toBe('');
    expect(wordAt('', 0)).toBe('');
  });

  it('survives an offset past the end of the text', () => {
    expect(wordAt('syllogisme', 400)).toBe('syllogisme');
  });
});

/**
 * Where the callout lands, against a real document.
 *
 * The position arithmetic is the one part of this feature that is easy to get
 * subtly wrong and impossible to notice in a unit test of the block itself: a
 * callout inserted one position early splits the paragraph it was meant to
 * follow, and the block is still perfectly well formed.
 */
describe('definitionInsertPosition', () => {
  function editorWith(doc: NoteDoc): Editor {
    return new Editor({ extensions: editorExtensions(''), content: doc });
  }

  const paragraph = (text: string): DocNode => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  });

  it('puts the callout after the paragraph the word is in, not inside it', () => {
    const editor = editorWith({
      type: 'doc',
      content: [paragraph('Un syllogisme valide.'), paragraph('La suite.')],
    });
    // Inside the first paragraph, on "syllogisme".
    editor.commands.setTextSelection(6);

    editor.commands.insertContentAt(definitionInsertPosition(editor.state.selection), {
      type: 'callout',
      attrs: { kind: 'info' },
      content: [paragraph('Définition.')],
    });

    const types = editor.getJSON().content?.map((node) => node.type);
    expect(types).toEqual(['paragraph', 'callout', 'paragraph']);
    // The paragraph it followed is intact, rather than split around the box.
    expect(editor.state.doc.child(0).textContent).toBe('Un syllogisme valide.');
    editor.destroy();
  });

  it('puts it after the whole list, not between two bullets', () => {
    const editor = editorWith({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph('Premier')] },
            { type: 'listItem', content: [paragraph('Second')] },
          ],
        },
      ],
    });
    // Inside the first bullet.
    editor.commands.setTextSelection(4);

    editor.commands.insertContentAt(definitionInsertPosition(editor.state.selection), {
      type: 'callout',
      attrs: { kind: 'info' },
      content: [paragraph('Définition.')],
    });

    const content = editor.getJSON().content ?? [];
    // Only the first two: the editor keeps a trailing empty paragraph after a
    // document that would otherwise end in a block, and that is not ours.
    expect(content.slice(0, 2).map((node) => node.type)).toEqual(['bulletList', 'callout']);
    // The list is still one list of two bullets, not two lists around a box.
    expect(content[0]?.content).toHaveLength(2);
    editor.destroy();
  });
});
