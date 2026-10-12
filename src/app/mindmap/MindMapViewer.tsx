/**
 * The full-size mind map.
 *
 * A radial map is routinely three or four times wider than the editor measure,
 * so the note can only ever show a thumbnail. This is where it is actually
 * read: the whole window, pan and zoom, and nothing else on screen.
 *
 * Two decisions worth keeping:
 *
 * - It renders into a portal on `document.body`. The block version lives inside
 *   a ProseMirror node view, and a `position: fixed` element there is at the
 *   mercy of whatever the editor's ancestors do with `transform`, `contain` and
 *   `overflow` — the previous overlay was laid out against the scroll container
 *   rather than the window, which is why it opened with its lower half cut off.
 * - Zooming sets the image's `width`/`height` rather than a CSS `transform:
 *   scale()`. A transform rasterises once and stretches the pixels; resizing an
 *   SVG makes the browser redraw it, so text is still sharp at 400%. The pan is
 *   a transform, because that one is a pure translation and costs nothing.
 *
 * The map is drawn through an `<img>`, not injected as markup. `svg` is an
 * attribute on a document node, and a document can arrive from a backup file —
 * an `<img>` is the boundary that makes an SVG a picture and not a script.
 */
import {
  FileImage,
  FilePlus2,
  FileText,
  Maximize2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePanZoom, ZOOM_STEP } from '@/app/graph/usePanZoom';
import { exportMindMapCommand, saveMindMapAsNoteCommand } from '@/lib/commands';
import { svgDataUri, svgSize } from '@/lib/mindmap/svg';
import type { MindMap } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
/** Breathing room around a fitted map, so the outermost labels are not welded
 * to the window edge. */
const FIT_PADDING = 48;

interface MindMapViewerProps {
  svg: string;
  title: string;
  data?: MindMap;
  onClose(): void;
}

export function MindMapViewer({ svg, title, data, onClose }: MindMapViewerProps) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState<
    'svg' | 'pdf' | 'png' | 'markdown' | 'note' | null
  >(null);
  const [error, setError] = useState('');

  const size = svgSize(svg);
  const source = svgDataUri(svg);

  // The gestures themselves live in `usePanZoom`, shared with the graph view.
  const { view, dragging, fitTo, zoomAt, stageProps, handleKey } = usePanZoom({
    stage,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    fitPadding: FIT_PADDING,
    // Never above 1:1 for a small map — blowing a six-node map up to fill a
    // 27" display makes it look like a poster, not a map.
    maxFitZoom: 1,
    onClose,
  });

  /** Centre the whole map in the stage. Also the "0" key and the fit button. */
  const fit = useCallback(() => {
    fitTo({ x: 0, y: 0, width: size.width, height: size.height });
  }, [fitTo, size.width, size.height]);

  // Before paint, so the map never appears at the wrong scale for a frame.
  useLayoutEffect(fit, [fit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => void handleKey(event, fit);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleKey, fit]);

  async function download(format: 'svg' | 'pdf' | 'png' | 'markdown') {
    setError('');
    setSaving(format);
    const outcome = await exportMindMapCommand({ svg, title, data }, format);
    setSaving(null);
    // A cancelled save dialog is the user changing their mind, not a failure.
    if (!outcome.ok && outcome.code !== 'not_supported') setError(outcome.message);
  }

  async function saveAsNote() {
    if (!data) return;
    setError('');
    setSaving('note');
    const courseId = useEditorStore.getState().note?.courseId ?? null;
    const outcome = await saveMindMapAsNoteCommand({ svg, title, data }, courseId);
    setSaving(null);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    onClose();
    await useEditorStore.getState().openNote(outcome.value.id);
  }

  return createPortal(
    <div className="nb-map-viewer" role="dialog" aria-modal="true" aria-label={title}>
      <header className="nb-map-viewer-bar">
        <h2 className="nb-map-viewer-title">{title}</h2>
        <div className="nb-map-viewer-controls">
          <button
            type="button"
            aria-label={t('mindMap.zoomOut')}
            title={t('mindMap.zoomOut')}
            onClick={() => zoomAt(1 / ZOOM_STEP)}
          >
            <Minus size={14} />
          </button>
          <span className="nb-map-viewer-scale" aria-live="polite">
            {Math.round((view?.k ?? 1) * 100)}%
          </span>
          <button
            type="button"
            aria-label={t('mindMap.zoomIn')}
            title={t('mindMap.zoomIn')}
            onClick={() => zoomAt(ZOOM_STEP)}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label={t('mindMap.fit')}
            title={t('mindMap.fit')}
            onClick={fit}
          >
            <Maximize2 size={14} />
          </button>
        </div>

        <div className="nb-map-viewer-controls">
          <button
            type="button"
            disabled={saving !== null}
            title={t('mindMap.downloadSvg')}
            onClick={() => void download('svg')}
          >
            <FileImage size={14} aria-hidden />
            {t('mindMap.svg')}
          </button>
          <button
            type="button"
            disabled={saving !== null}
            title={t('mindMap.downloadPdf')}
            onClick={() => void download('pdf')}
          >
            <FileText size={14} aria-hidden />
            {t('mindMap.pdf')}
          </button>
          <button
            type="button"
            disabled={saving !== null}
            title={t('mindMap.downloadPng')}
            onClick={() => void download('png')}
          >
            <FileImage size={14} aria-hidden />
            {t('mindMap.png')}
          </button>
          <button
            type="button"
            disabled={saving !== null || !data}
            title={t('mindMap.downloadOutline')}
            onClick={() => void download('markdown')}
          >
            <FileText size={14} aria-hidden />
            {t('mindMap.outline')}
          </button>
          <button
            type="button"
            disabled={saving !== null || !data}
            title={t('mindMap.saveAsNote')}
            onClick={() => void saveAsNote()}
          >
            <FilePlus2 size={14} aria-hidden />
            {t('mindMap.note')}
          </button>
        </div>

        <button
          type="button"
          className="nb-map-viewer-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>

      <div
        ref={stage}
        className="nb-map-viewer-stage"
        data-dragging={dragging || undefined}
        {...stageProps}
      >
        <div
          className="nb-map-viewer-canvas"
          style={{
            transform: `translate(${view?.x ?? 0}px, ${view?.y ?? 0}px)`,
            visibility: view ? 'visible' : 'hidden',
          }}
        >
          <img
            src={source}
            alt={title}
            draggable={false}
            width={size.width * (view?.k ?? 1)}
            height={size.height * (view?.k ?? 1)}
          />
        </div>
      </div>

      <p className="nb-map-viewer-hint" data-tone={error ? 'danger' : undefined}>
        {error || t('mindMap.hint')}
      </p>
    </div>,
    document.body,
  );
}
