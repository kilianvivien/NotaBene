import { Node, mergeAttributes } from '@tiptap/core';

export const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-note-id'),
      },
      title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-title') ?? element.textContent ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-wiki-link]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-wiki-link': '',
        'data-note-id': HTMLAttributes.noteId,
        'data-title': HTMLAttributes.title,
        href: HTMLAttributes.noteId ? `notabene://note/${HTMLAttributes.noteId}` : '#',
      }),
      String(HTMLAttributes.title),
    ];
  },
});
