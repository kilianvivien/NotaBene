/**
 * What the student meant to look up.
 *
 * Two ways in, and they must both work without ceremony. A selection is an
 * explicit answer and is taken as given. An empty caret is the common one — the
 * word is right there, the cursor is in it, and asking the student to select it
 * first would make a two-second lookup a four-second one during a lecture.
 *
 * The passage that comes back with it is the whole block, not a window around
 * the word: a sentence boundary is not something to detect reliably across
 * French, English, abbreviations and formulas, and the block is what the model
 * needs anyway.
 */
import type { Editor } from '@tiptap/core';
import type { Selection } from '@tiptap/pm/state';

export interface SelectedTerm {
  term: string;
  /** The block the term sits in, which is what settles its sense. */
  context: string;
}

/** Letters, digits and the joiners that live inside words: a hyphen ("laissez-
 * faire"), an apostrophe of either shape ("l'État" — the selection keeps the
 * article, and the model returns the headword), and the combining marks a
 * decomposed "é" arrives as. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’-]/u;

/**
 * The word containing `offset`, or the one just before it.
 *
 * The fallback matters more than it looks: a caret placed by double-clicking a
 * word and then pressing an arrow key, or left at the end of a word the student
 * just typed, sits *after* the last letter — where looking only forward finds
 * a space and reports no word at all.
 */
export function wordAt(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  let start = at;
  let end = at;
  while (end < text.length && WORD_CHAR.test(text[end] ?? '')) end += 1;
  while (start > 0 && WORD_CHAR.test(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, end);
}

/**
 * Read the term and its passage out of the editor's current selection.
 *
 * Returns an empty term rather than null when there is nothing under the
 * caret. The dialog opens either way — with the field empty, so a student who
 * ran the command from the menu with no selection can just type the word.
 */
export function selectedTerm(editor: Editor): SelectedTerm {
  const { state } = editor;
  const { from, to, $from } = state.selection;
  // `textBetween` with a block separator, so two paragraphs in the passage do
  // not run into one word across the boundary.
  const context =
    $from.depth >= 1
      ? $from.node(1).textBetween(0, $from.node(1).content.size, '\n', ' ')
      : '';

  if (from !== to) {
    return { term: state.doc.textBetween(from, to, ' ', ' ').trim(), context };
  }
  return { term: wordAt($from.parent.textContent, $from.parentOffset), context };
}

/**
 * Where the box goes: after the block the word is in, never at the caret.
 *
 * A callout is a block node, so inserting one at the caret splits the very
 * paragraph the student was reading around the box that explains it. Depth 1 is
 * the top-level block, which also settles the list case in the way that reads
 * best — a definition lands after the whole list rather than wedged between two
 * bullets, where it would look like a third one.
 *
 * A node selection — an image, a drawing — sits at depth 0 with no block to be
 * inside, and `to` is already the position just after it.
 */
export function definitionInsertPosition(selection: Selection): number {
  const { $to } = selection;
  return $to.depth >= 1 ? $to.after(1) : $to.pos;
}
