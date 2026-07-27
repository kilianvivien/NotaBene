import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import i18n from '@/lib/i18n';

export function toggleSummaryLabel(summary: unknown): string {
  const label = String(summary ?? 'Details');
  // Q&A notes created before the prompt was localised persist this semantic
  // marker in their document. Keep those existing notes localised too.
  return label === 'Answer' ? i18n.t('editor.answer') : label;
}

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
      ['summary', { contenteditable: 'false' }, toggleSummaryLabel(summary)],
      ['div', { 'data-toggle-content': '' }, 0],
    ];
  },

  addProseMirrorPlugins() {
    const nodeName = this.name;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(view, event) {
              const summary =
                event.target instanceof Element ? event.target.closest('summary') : null;
              const details =
                summary?.closest<HTMLDetailsElement>('details[data-toggle]');
              const content = details?.querySelector<HTMLElement>(
                ':scope > [data-toggle-content]',
              );
              if (!summary || !details || !content || !view.dom.contains(details)) {
                return false;
              }

              // The browser's native toggle is only a DOM mutation, which
              // ProseMirror immediately replaces from the document. Persist the
              // state as a node attribute so opening survives that reconciliation.
              event.preventDefault();
              const position = view.posAtDOM(content, 0) - 1;
              const node = view.state.doc.nodeAt(position);
              if (node?.type.name !== nodeName) return false;
              view.dispatch(
                view.state.tr.setNodeMarkup(position, undefined, {
                  ...node.attrs,
                  open: !node.attrs.open,
                }),
              );
              return true;
            },
          },
        },
      }),
    ];
  },
});
