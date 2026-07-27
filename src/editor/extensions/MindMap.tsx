/**
 * The mind map block.
 *
 * Structurally the same deal as `Drawing`: the node carries both the data it
 * was built from and a rendered SVG, and everything downstream — the editor,
 * HTML export, PDF, DOCX — draws the SVG. The data is kept because a map is
 * worth far more when the tree behind the picture is still there, and because
 * it is what a future "expand this branch" would need.
 *
 * A map is wider than the editor measure, so what sits in the note is a
 * thumbnail with a caption; reading one happens in `MindMapViewer`, full window
 * and zoomable. Squinting at a 700px-wide radial tree is not revision.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { Maximize2, Network } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MindMapViewer } from '@/app/mindmap/MindMapViewer';
import { svgDataUri } from '@/lib/mindmap/svg';

function MindMapView({ node, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const svg = typeof node.attrs.svg === 'string' ? node.attrs.svg : '';
  const title = String(node.attrs.title ?? t('ai.mindMap'));
  const nodeCount = Array.isArray((node.attrs.data as { nodes?: unknown[] })?.nodes)
    ? (node.attrs.data as { nodes: unknown[] }).nodes.length
    : 0;

  return (
    <NodeViewWrapper
      as="figure"
      className="nb-mind-map"
      data-selected={selected || undefined}
      contentEditable={false}
    >
      <button
        type="button"
        className="nb-mind-map-preview"
        disabled={!svg}
        onClick={() => {
          if (svg) setOpen(true);
        }}
        aria-label={t('ai.mindMapZoom')}
      >
        {svg ? (
          <>
            <img src={svgDataUri(svg)} alt={title} draggable={false} />
            <span className="nb-mind-map-open">
              <Maximize2 size={13} aria-hidden />
              {t('ai.mindMapZoom')}
            </span>
          </>
        ) : (
          <span className="nb-mind-map-placeholder">
            <Network size={22} aria-hidden />
            {title}
          </span>
        )}
      </button>

      <figcaption>
        <Network size={12} aria-hidden />
        <span>{title}</span>
        {nodeCount > 0 && <span>· {t('ai.mindMapNodes', { count: nodeCount })}</span>}
      </figcaption>

      {open && (
        <MindMapViewer svg={svg} title={title} onClose={() => setOpen(false)} />
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
