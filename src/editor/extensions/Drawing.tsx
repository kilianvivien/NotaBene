import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { PencilRuler } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DrawingEditor = lazy(() => import('./DrawingEditor'));

function DrawingView({ node, updateAttributes, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const svg = typeof node.attrs.svg === 'string' ? node.attrs.svg : '';

  return (
    <NodeViewWrapper
      as="figure"
      className="nb-drawing"
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="nb-drawing-preview"
        onDoubleClick={() => setEditing(true)}
        onClick={() => {
          if (!svg) setEditing(true);
        }}
        aria-label={t('editor.editDrawing')}
      >
        {svg ? (
          <img
            alt={String(node.attrs.title ?? t('editor.drawing'))}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            draggable={false}
          />
        ) : (
          <span>
            <PencilRuler size={24} />
            {t('editor.openDrawing')}
          </span>
        )}
      </button>
      <figcaption>{String(node.attrs.title ?? t('editor.drawing'))}</figcaption>

      {editing && (
        <Suspense
          fallback={
            <div className="nb-drawing-loading">{t('editor.loadingDrawing')}</div>
          }
        >
          <DrawingEditor
            data={node.attrs.data}
            onCancel={() => setEditing(false)}
            onSave={(data, nextSvg) => {
              updateAttributes({ data, svg: nextSvg });
              setEditing(false);
            }}
          />
        </Suspense>
      )}
    </NodeViewWrapper>
  );
}

export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      data: { default: { elements: [], appState: {}, files: {} } },
      svg: { default: '' },
      title: { default: 'Drawing' },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-drawing]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, { 'data-drawing': '' }),
      ['figcaption', {}, String(HTMLAttributes.title ?? 'Drawing')],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawingView);
  },
});
