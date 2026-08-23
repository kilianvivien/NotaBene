import { Extension } from '@tiptap/core';

/** Targets live in document JSON, not the library schema: they belong to the
 * manuscript and survive copies, backups, Markdown transforms, and history. */
export const LongForm = Extension.create({
  name: 'longForm',

  addGlobalAttributes() {
    return [
      {
        types: ['doc', 'heading'],
        attributes: {
          writingTarget: {
            default: null,
            parseHTML: (element) => {
              const value = Number(element.getAttribute('data-writing-target'));
              return Number.isInteger(value) && value > 0 ? value : null;
            },
            renderHTML: (attributes) =>
              attributes.writingTarget
                ? { 'data-writing-target': attributes.writingTarget }
                : {},
          },
        },
      },
    ];
  },
});
