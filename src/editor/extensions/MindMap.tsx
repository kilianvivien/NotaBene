/**
 * The mind map block.
 *
 * Structurally the same deal as `Drawing`: the node carries both the data it
 * was built from and a rendered SVG, and everything downstream — the editor,
 * HTML export, PDF, DOCX — draws the SVG. The data is kept because a map is
 * worth far more when the tree behind the picture is still there, and because
 * it is what a future "expand this branch" would need.
 *
 * A map is wider than the editor measure, so the preview is scaled to fit and
 * clicking it opens the map at full size. Squinting at a 700px-wide radial tree
 * is not revision.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { Network, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function MindMapView({ node, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const [zoomed, setZoomed] = useState(false);
  const svg = typeof node.attrs.svg === 'string' ? node.attrs.svg : '';
  const title = String(node.attrs.title ?? t('ai.mindMap'));

  return (
    <NodeViewWrapper
      as="figure"
      className="nb-mind-map"
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="nb-mind-map-preview"
        onClick={() => {
          if (svg) setZoomed(true);
        }}
        aria-label={t('ai.mindMapZoom')}
      >
        {svg ? (
          <img src={svgDataUri(svg)} alt={title} draggable={false} />
        ) : (
          <span>
            <Network size={22} aria-hidden />
            {title}
          </span>
        )}
      </button>
      <figcaption>{title}</figcaption>

      {zoomed && (
        <div
          className="nb-mind-map-zoom"
          role="dialog"
          aria-label={title}
          onClick={() => setZoomed(false)}
        >
          <button
            type="button"
            className="nb-mind-map-close"
            aria-label={t('common.close')}
            onClick={() => setZoomed(false)}
          >
            <X size={16} />
          </button>
          <img src={svgDataUri(svg)} alt={title} draggable={false} />
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const MindMap = Node.create({
  name: 'mindMap',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      data: { default: null },
      svg: { default: '' },
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
      ['figcaption', {}, String(HTMLAttributes.title ?? 'Mind map')],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MindMapView);
  },
});
