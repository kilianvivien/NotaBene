import { Node, mergeAttributes } from '@tiptap/core';

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      summary: {
        default: 'Details',
        parseHTML: (element) =>
          element.querySelector(':scope > summary')?.textContent ?? 'Details',
      },
      open: {
        default: false,
        parseHTML: (element) => element.hasAttribute('open'),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'details[data-toggle]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { summary, open, ...attributes } = HTMLAttributes;
    return [
      'details',
      mergeAttributes(attributes, {
        'data-toggle': '',
        ...(open ? { open: '' } : {}),
      }),
      ['summary', { contenteditable: 'false' }, String(summary)],
      ['div', { 'data-toggle-content': '' }, 0],
    ];
  },
});
