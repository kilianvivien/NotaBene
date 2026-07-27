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
import { FileImage, FileText, Maximize2, Minus, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { exportMindMapCommand } from '@/lib/commands';
import { svgDataUri, svgSize } from '@/lib/mindmap/svg';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
/** One press of the +/− control, and one notch of a mouse wheel. */
const STEP = 1.25;
/** Breathing room around a fitted map, so the outermost labels are not welded
 * to the window edge. */
const FIT_PADDING = 48;

interface View {
  x: number;
  y: number;
  k: number;
}

function clamp(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

interface MindMapViewerProps {
  svg: string;
  title: string;
  onClose(): void;
}

export function MindMapViewer({ svg, title, onClose }: MindMapViewerProps) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState<'svg' | 'pdf' | null>(null);
  const [error, setError] = useState('');

  const size = svgSize(svg);
  const source = svgDataUri(svg);

  /** Centre the whole map in the stage. Also the "0" key and the fit button. */
  const fit = useCallback(() => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const available = {
      width: Math.max(1, box.width - FIT_PADDING * 2),
      height: Math.max(1, box.height - FIT_PADDING * 2),
    };
    // Never below 1:1 for a small map — blowing a six-node map up to fill a 27"
    // display makes it look like a poster, not a map.
    const k = clamp(
      Math.min(available.width / size.width, available.height / size.height, 1),
    );
    setView({
      x: (box.width - size.width * k) / 2,
      y: (box.height - size.height * k) / 2,
      k,
    });
  }, [size.width, size.height]);

  // Before paint, so the map never appears at the wrong scale for a frame.
  useLayoutEffect(fit, [fit]);

  /** Zoom about a point in stage coordinates, so whatever is under the cursor
   * stays under the cursor. Zooming about the centre instead makes following a
   * branch outwards a game of chase-the-node. */
  const zoomAt = useCallback((factor: number, point?: { x: number; y: number }) => {
    setView((current) => {
      if (!current) return current;
      const k = clamp(current.k * factor);
      if (k === current.k) return current;
      const box = stage.current?.getBoundingClientRect();
      const anchor = point ?? {
        x: (box?.width ?? 0) / 2,
        y: (box?.height ?? 0) / 2,
      };
      const scale = k / current.k;
      return {
        k,
        x: anchor.x - (anchor.x - current.x) * scale,
        y: anchor.y - (anchor.y - current.y) * scale,
      };
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === '+' || event.key === '=') {
        zoomAt(STEP);
      } else if (event.key === '-' || event.key === '_') {
        zoomAt(1 / STEP);
      } else if (event.key === '0') {
        fit();
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, zoomAt, fit]);

  /**
   * Wheel handling, bound natively because React's `onWheel` is passive and
   * cannot call `preventDefault` — without which a trackpad pinch zooms the
   * whole webview instead of the map.
   *
   * A pinch on a Mac trackpad arrives as a wheel event with `ctrlKey` set, so
   * the same branch serves pinch and ⌘-scroll; a plain two-finger scroll pans,
   * which is what every other canvas on this machine does.
   */
  useEffect(() => {
    const element = stage.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // The delta is clamped before it becomes a factor. A trackpad pinch
        // arrives as a stream of small deltas and is unaffected; a mouse wheel
        // notch can be 120 or more in one event, and unclamped that is a jump
        // of several hundred percent from one click of the wheel.
        const delta = Math.max(-40, Math.min(40, event.deltaY));
        zoomAt(Math.exp(-delta / 180), {
          x: event.clientX - box.left,
          y: event.clientY - box.top,
        });
      } else {
        setView((current) =>
          current
            ? { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }
            : current,
        );
      }
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  function startPan(event: React.PointerEvent) {
    if (event.button !== 0) return;
    const origin = { x: event.clientX, y: event.clientY };
    const start = view;
    if (!start) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);

    const move = (moved: PointerEvent) => {
      setView({
        ...start,
        x: start.x + (moved.clientX - origin.x),
        y: start.y + (moved.clientY - origin.y),
      });
    };
    const end = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  async function download(format: 'svg' | 'pdf') {
    setError('');
    setSaving(format);
    const outcome = await exportMindMapCommand({ svg, title }, format);
    setSaving(null);
    // A cancelled save dialog is the user changing their mind, not a failure.
    if (!outcome.ok && outcome.code !== 'not_supported') setError(outcome.message);
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
            onClick={() => zoomAt(1 / STEP)}
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
            onClick={() => zoomAt(STEP)}
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
        onPointerDown={startPan}
        onDoubleClick={(event) => {
          const box = stage.current?.getBoundingClientRect();
          if (!box) return;
          zoomAt(STEP * STEP, {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          });
        }}
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
