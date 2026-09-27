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
      /**
       * What the link reads as, when that is not the title — an Obsidian
       * alias, `[[Week 4|damping]]`. Navigation and backlinks only ever use
       * `title` and `noteId`; this is presentation. Absent on every link
       * typed in NotaBene, which is why it needed no schema bump.
       */
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
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
        'data-label': HTMLAttributes.label,
        href: HTMLAttributes.noteId ? `notabene://note/${HTMLAttributes.noteId}` : '#',
      }),
      String(HTMLAttributes.label || HTMLAttributes.title),
    ];
  },
});
