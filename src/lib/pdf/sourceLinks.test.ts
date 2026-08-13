import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions } from '@/editor/extensions';
import { buildPdfSourceHref, parsePdfSourceHref } from './sourceLinks';

describe('PDF source links', () => {
  it('round-trips an attachment, page, and annotation', () => {
    const source = {
      attachmentId: 'paper/with spaces',
      page: 17,
      annotationId: 'highlight-2',
    };
    expect(parsePdfSourceHref(buildPdfSourceHref(source))).toEqual(source);
  });

  it('rejects malformed and non-PDF links', () => {
    expect(parsePdfSourceHref('https://example.com')).toBeNull();
    expect(parsePdfSourceHref('notabene-pdf:paper?page=0')).toBeNull();
    expect(parsePdfSourceHref('notabene-pdf:?page=2')).toBeNull();
  });

  it('survives TipTap link sanitization in an extracted block', () => {
    const href = buildPdfSourceHref({ attachmentId: 'paper', page: 7 });
    const editor = new Editor({
      extensions: editorExtensions(''),
      content: {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Source: paper.pdf, p. 7',
                    marks: [{ type: 'link', attrs: { href } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(editor.getHTML()).toContain(`href="${href}"`);
    editor.destroy();
  });
});
