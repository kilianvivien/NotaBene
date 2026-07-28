import {
  Node,
  mergeAttributes,
  nodeInputRule,
  type NodeViewRendererProps,
} from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import katex from 'katex';
// KaTeX ships its layout as a stylesheet. Without it the renderer's MathML and
// HTML branches both show, so an equation read as its own source doubled.
import 'katex/dist/katex.min.css';
import i18n from '@/lib/i18n';
import { editorPrompt } from '../editorPrompt';

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
      void (async () => {
        const latex = await editorPrompt({
          title: i18n.t('editor.mathPrompt'),
          value: String(node.attrs.latex ?? ''),
          math: true,
        });
        if (latex === null) return;
        // The dialog is modal but not instantaneous, so the node may have moved
        // by the time it closes — read the position back out afterwards.
        const position = getPos();
        if (position === undefined) return;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(position, undefined, { ...node.attrs, latex });
            return true;
          })
          .run();
      })();
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
