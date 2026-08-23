import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { editorPrompt } from '@/editor/editorPrompt';
import { useTranslation } from 'react-i18next';

function referenceNumber({ editor, getPos }: NodeViewProps): number {
  const position = typeof getPos === 'function' ? getPos() : undefined;
  if (typeof position !== 'number') return 1;
  let number = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'footnote' && pos <= position) number += 1;
  });
  return Math.max(1, number);
}

function FootnoteView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { editor, node, updateAttributes } = props;
  const note = String(node.attrs.note ?? '');
  const kind = node.attrs.kind === 'endnote' ? 'endnote' : 'footnote';
  const kindLabel = t(`longForm.${kind}`);
  const number = referenceNumber(props);

  return (
    <NodeViewWrapper as="sup" className="nb-footnote" data-kind={kind}>
      <button
        type="button"
        title={note}
        aria-label={`${kindLabel} ${number}: ${note}`}
        contentEditable={false}
        onClick={() => {
          if (!editor.isEditable) return;
          void editorPrompt({
            title:
              kind === 'endnote' ? t('longForm.editEndnote') : t('longForm.editFootnote'),
            value: note,
          }).then((value) => {
            if (value !== null && value.trim()) updateAttributes({ note: value.trim() });
          });
        }}
      >
        {number}
      </button>
    </NodeViewWrapper>
  );
}

/** A semantic note reference. Its prose is an attribute because the reference
 * must remain an inline atom while the exporters place the prose elsewhere. */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-note-id'),
      },
      kind: {
        default: 'footnote',
        parseHTML: (element) =>
          element.getAttribute('data-kind') === 'endnote' ? 'endnote' : 'footnote',
      },
      note: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-note') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-notabene-note]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        'data-notabene-note': '',
        'data-note-id': HTMLAttributes.id,
        'data-kind': HTMLAttributes.kind,
        'data-note': HTMLAttributes.note,
        title: HTMLAttributes.note,
      }),
      '†',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FootnoteView);
  },
});
