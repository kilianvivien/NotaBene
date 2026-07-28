import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assets } from '@/lib/adapters';

function AssetImageView({ node, selected, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  /**
   * The caption is buffered rather than driven straight off `node.attrs`.
   * Writing every keystroke back through `updateAttributes` dispatches a
   * ProseMirror transaction, which re-renders this node view and lets React
   * assign `input.value` again — and assigning `value` mid-composition cancels
   * it. On a French keyboard that turned the `^` dead key into a literal `^`
   * followed by a bare `e` instead of `ê`. So: local state while composing,
   * and the attribute is written once the composition is committed.
   */
  const attrCaption = String(node.attrs.caption ?? '');
  const [caption, setCaption] = useState(attrCaption);
  const composing = useRef(false);

  useEffect(() => {
    if (composing.current) return;
    setCaption(attrCaption);
  }, [attrCaption]);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    void assets.urlFor(String(node.attrs.assetId)).then((url) => {
      if (!active) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      createdUrl = url;
      setSrc(url);
    });
    return () => {
      active = false;
      if (createdUrl?.startsWith('blob:')) URL.revokeObjectURL(createdUrl);
    };
  }, [node.attrs.assetId]);

  function beginResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = frame.current?.getBoundingClientRect().width ?? 480;

    const onMove = (move: PointerEvent) => {
      const width = Math.max(160, Math.min(960, startWidth + move.clientX - startX));
      updateAttributes({ width: Math.round(width) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  return (
    <NodeViewWrapper
      as="figure"
      className="nb-asset-image"
      data-align={node.attrs.align}
      data-selected={selected || undefined}
    >
      <div
        ref={frame}
        className="nb-asset-image-frame"
        style={{ width: `${String(node.attrs.width)}px`, maxWidth: '100%' }}
      >
        {src ? (
          <img src={src} alt={String(node.attrs.alt ?? '')} draggable={false} />
        ) : (
          <div className="nb-asset-loading" aria-hidden />
        )}
        <button
          type="button"
          className="nb-image-resize"
          aria-label={t('editor.resizeImage')}
          onPointerDown={beginResize}
        />
      </div>

      <input
        value={caption}
        onChange={(event) => {
          setCaption(event.target.value);
          if (!composing.current) updateAttributes({ caption: event.target.value });
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setCaption(event.currentTarget.value);
          updateAttributes({ caption: event.currentTarget.value });
        }}
        placeholder={t('editor.imageCaption')}
        aria-label={t('editor.imageCaption')}
        className="nb-image-caption"
      />

      {selected && (
        <div className="nb-node-toolbar" contentEditable={false}>
          {(
            [
              { align: 'left', Icon: AlignLeft },
              { align: 'center', Icon: AlignCenter },
              { align: 'right', Icon: AlignRight },
            ] satisfies { align: string; Icon: LucideIcon }[]
          ).map(({ align, Icon }) => (
            <button
              key={align}
              type="button"
              aria-label={t(
                align === 'left'
                  ? 'editor.alignLeft'
                  : align === 'right'
                    ? 'editor.alignRight'
                    : 'editor.alignCenter',
              )}
              aria-pressed={node.attrs.align === align}
              onClick={() => updateAttributes({ align })}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const AssetImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      assetId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-asset-id') ?? '',
      },
      alt: { default: '' },
      caption: {
        default: '',
        parseHTML: (element) =>
          element.querySelector('figcaption')?.textContent ??
          element.getAttribute('data-caption') ??
          '',
      },
      align: {
        default: 'center',
        parseHTML: (element) => element.getAttribute('data-align') ?? 'center',
      },
      width: {
        default: 640,
        parseHTML: (element) => Number(element.getAttribute('data-width') ?? 640),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-asset-image]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        'data-asset-image': '',
        'data-asset-id': HTMLAttributes.assetId,
        'data-caption': HTMLAttributes.caption,
        'data-align': HTMLAttributes.align,
        'data-width': HTMLAttributes.width,
      }),
      ['figcaption', {}, String(HTMLAttributes.caption ?? '')],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssetImageView);
  },
});
