/**
 * A textblock's text, with a way back to document positions.
 *
 * `textBetween` gives the text but loses where each character lives once an
 * inline node — a wiki link chip, an equation, a footnote marker — sits in the
 * middle. Proofreading has to put a replacement back at the exact characters
 * it was computed for, so this walks the block itself: every character of a
 * text node maps to its own position, and every other inline node reads as
 * one `\ufffc` that no correction may touch.
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export const INLINE_NODE = '\ufffc';

export interface ParagraphText {
  text: string;
  /** Document position of `text[i]`, relative to the block's content start. */
  positions: number[];
}

export function paragraphText(block: ProseMirrorNode): ParagraphText {
  let text = '';
  const positions: number[] = [];
  block.forEach((child, offset) => {
    if (child.isText) {
      const value = child.text ?? '';
      for (let index = 0; index < value.length; index += 1) {
        text += value[index];
        positions.push(offset + index);
      }
    } else {
      text += INLINE_NODE;
      positions.push(offset);
    }
  });
  return { text, positions };
}

/**
 * The document range of `length` characters starting at `index`, or `null`
 * when it would cross an inline node and so is not plain text.
 */
export function rangeFor(
  paragraph: ParagraphText,
  contentStart: number,
  index: number,
  length: number,
): { from: number; to: number } | null {
  if (length <= 0) return null;
  const first = paragraph.positions[index];
  const last = paragraph.positions[index + length - 1];
  if (first === undefined || last === undefined) return null;
  const span = paragraph.text.slice(index, index + length);
  if (span.includes(INLINE_NODE) || last - first !== length - 1) return null;
  return { from: contentStart + first, to: contentStart + last + 1 };
}
