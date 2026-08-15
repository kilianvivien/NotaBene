import { Node, mergeAttributes } from '@tiptap/core';

/**
 * An inline reference to a task, rendered as a live chip.
 *
 * Deliberately carries nothing but the id. The title and status shown in the
 * editor are read from the store at render time, so ticking a task off in the
 * Tasks view updates every paragraph that mentions it — a copy of the title
 * baked into the document would be stale the first time it was renamed.
 *
 * The exporters are the exception: they have no store to read, so they render
 * the title captured at export time. That mirrors how `drawing` and `mindMap`
 * already behave.
 *
 * `DocNodeSchema` is structural rather than a fixed node vocabulary, so this
 * needs no change to the contract — which is what makes the chip cheap.
 */
export const TaskRef = Node.create({
  name: 'taskRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      taskId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-task-id'),
      },
      /**
       * The title as it stood when the chip was inserted.
       *
       * Not the source of truth — the store is — but it is what survives a copy
       * into another app, an export, and a note read by an agent that has no
       * way to resolve the id.
       */
      label: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-label') ?? element.textContent ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-task-ref]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-task-ref': '',
        'data-task-id': HTMLAttributes.taskId,
        'data-label': HTMLAttributes.label,
      }),
      `☐ ${String(HTMLAttributes.label ?? '')}`,
    ];
  },
});
