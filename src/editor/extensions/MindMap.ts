import { Node, mergeAttributes } from '@tiptap/core';

export const MindMap = Node.create({
  name: 'mindMap',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      data: { default: null },
      title: { default: 'Mind map' },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-mind-map]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, { 'data-mind-map': '' }),
      ['div', { class: 'nb-future-block' }, String(HTMLAttributes.title)],
    ];
  },
});
