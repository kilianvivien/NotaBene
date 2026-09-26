import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { editorExtensions } from '../extensions';
import { INLINE_NODE, paragraphText, rangeFor } from './paragraphText';

let editor: Editor | undefined;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

/** A paragraph with a wiki link chip and a bold run in it — the two things
 * that make text offsets and document positions disagree. */
function open(): Editor {
  editor = new Editor({
    extensions: editorExtensions('Write…'),
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Voir ' },
            { type: 'wikiLink', attrs: { title: 'Cours 3', noteId: null } },
            { type: 'text', text: ' pour la ' },
            { type: 'text', text: 'cellulle', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' animale.' },
          ],
        },
      ],
    },
  });
  return editor;
}

describe('paragraph text', () => {
  it('reads an inline node as one placeholder character', () => {
    const current = open();
    const block = current.state.doc.child(0);
    expect(paragraphText(block).text).toBe(
      `Voir ${INLINE_NODE} pour la cellulle animale.`,
    );
  });

  it('maps a span after an inline node back to the right characters', () => {
    const current = open();
    const block = current.state.doc.child(0);
    const mapped = paragraphText(block);
    const index = mapped.text.indexOf('cellulle');
    const range = rangeFor(mapped, 1, index, 'cellulle'.length);
    expect(range).not.toBeNull();
    expect(current.state.doc.textBetween(range!.from, range!.to)).toBe('cellulle');

    current.view.dispatch(current.state.tr.insertText('cellule', range!.from, range!.to));
    // The chip survived, and the correction kept the bold it replaced.
    expect(JSON.stringify(current.getJSON())).toContain('"wikiLink"');
    expect(JSON.stringify(current.getJSON())).toContain('{"type":"bold"}]');
    expect(current.state.doc.textContent).toContain('pour la cellule animale.');
  });

  it('refuses a span that crosses an inline node', () => {
    const current = open();
    const mapped = paragraphText(current.state.doc.child(0));
    expect(rangeFor(mapped, 1, 3, 5)).toBeNull();
  });
});
