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
import { Maximize2, Network, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MindMapEditor } from '@/app/mindmap/MindMapEditor';
import { MindMapViewer } from '@/app/mindmap/MindMapViewer';
import { svgDataUri } from '@/lib/mindmap/svg';
import { MindMapSchema } from '@/lib/schema';

function MindMapView({ node, selected, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const svg = typeof node.attrs.svg === 'string' ? node.attrs.svg : '';
  const title = String(node.attrs.title ?? t('ai.mindMap'));
  const nodeCount = Array.isArray((node.attrs.data as { nodes?: unknown[] })?.nodes)
    ? (node.attrs.data as { nodes: unknown[] }).nodes.length
    : 0;
  const map = MindMapSchema.safeParse(node.attrs.data);
  const collapsed = Array.isArray(node.attrs.collapsed)
    ? node.attrs.collapsed.filter((id: unknown): id is string => typeof id === 'string')
    : [];

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
        {map.success && (
          <button
            type="button"
            className="nb-mind-map-edit"
            aria-label={t('mindMap.edit')}
            onClick={() => setEditing(true)}
          >
            <Pencil size={11} aria-hidden />
            {t('mindMap.edit')}
          </button>
        )}
      </figcaption>

      {open && (
        <MindMapViewer
          svg={svg}
          title={title}
          data={map.success ? map.data : undefined}
          onClose={() => setOpen(false)}
        />
      )}
      {editing && map.success && (
        <MindMapEditor
          open
          map={map.data}
          collapsed={collapsed}
          onClose={() => setEditing(false)}
          onSave={(data, nextCollapsed, nextSvg) => {
            updateAttributes({
              data,
              collapsed: nextCollapsed,
              svg: nextSvg,
              title: data.title,
            });
            setEditing(false);
          }}
        />
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
      collapsed: { default: [] },
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
