import {
  Node,
  mergeAttributes,
  nodeInputRule,
  type NodeViewRendererProps,
} from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import katex from 'katex';
import i18n from '@/lib/i18n';

function mathNodeView(block: boolean) {
  return ({ node: initialNode, getPos, editor }: NodeViewRendererProps) => {
    let node = initialNode;
    const dom = document.createElement(block ? 'div' : 'span');
    dom.className = block ? 'nb-math-block' : 'nb-math-inline';
    dom.contentEditable = 'false';

    const render = () => {
      try {
        katex.render(String(node.attrs.latex ?? ''), dom, {
          displayMode: block,
          throwOnError: false,
          strict: false,
        });
      } catch {
        dom.textContent = String(node.attrs.latex ?? '');
      }
    };
    render();

    dom.addEventListener('dblclick', () => {
      if (typeof getPos !== 'function') return;
      const position = getPos();
      if (position === undefined) return;
      const latex = window.prompt(
        i18n.t('editor.mathPrompt'),
        String(node.attrs.latex ?? ''),
      );
      if (latex === null) return;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(position, undefined, { ...node.attrs, latex });
          return true;
        })
        .run();
    });

    return {
      dom,
      update(updated: ProseMirrorNode) {
        if (updated.type !== node.type) return false;
        node = updated;
        render();
        return true;
      },
    };
  };
}

export const MathInline = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-math-inline]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-math-inline': '',
        'data-latex': HTMLAttributes.latex,
      }),
    ];
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /\$([^$\n]+)\$$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[1] }),
      }),
    ];
  },

  addNodeView() {
    return mathNodeView(false);
  },
});

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-math-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-math-block': '',
        'data-latex': HTMLAttributes.latex,
      }),
    ];
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /^\$\$([^$]+)\$\$$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[1] }),
      }),
    ];
  },

  addNodeView() {
    return mathNodeView(true);
  },
});
