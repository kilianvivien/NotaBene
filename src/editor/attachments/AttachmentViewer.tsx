/**
 * Full-window attachment preview.
 *
 * Images use the same fit, pan, and zoom model as mind maps. Other media keeps
 * its native viewer, while every attachment can be saved back to disk without
 * changing its original bytes.
 */
import { Download, FileOutput, Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  attachmentKindLabel,
  attachmentPreviewKind,
} from '@/lib/attachments/previewSupport';
import { beginAttachmentImportCommand, saveAttachmentCommand } from '@/lib/commands';
import { documentImportSupported } from '@/lib/import/documentImport';
import type { Attachment } from '@/lib/schema';
import { AttachmentDocumentPreview } from './AttachmentDocumentPreview';
import { DocumentFindBar } from './DocumentFindBar';
import { useDocumentSearch } from './useDocumentSearch';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const STEP = 1.25;
const FIT_PADDING = 48;

interface View {
  x: number;
  y: number;
  k: number;
}

function clamp(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

interface AttachmentViewerProps {
  attachment: Attachment;
  blob: Blob;
  mime: string;
  url: string;
  onClose(): void;
}

export function AttachmentViewer({
  attachment,
  blob,
  mime,
  url,
  onClose,
}: AttachmentViewerProps) {
  const { t } = useTranslation();
  const stage = useRef<HTMLElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const gesture = useRef<{ anchor: { x: number; y: number }; scale: number } | null>(
    null,
  );
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const documentRef = useRef<HTMLDivElement>(null);
  const previewKind = attachmentPreviewKind(attachment.name, mime);
  const isImage = previewKind === 'image';
  const convertible = documentImportSupported(attachment.name);
  const documentKind =
    previewKind === 'pdf' ||
    previewKind === 'docx' ||
    previewKind === 'odt' ||
    previewKind === 'markdown' ||
    previewKind === 'rtf' ||
    previewKind === 'text'
      ? previewKind
      : null;
  /** A PDF never lands here — `AttachmentPanel` sends it to the reader, which
   * searches pages rather than a DOM. */
  const searchable = documentKind !== null && documentKind !== 'pdf';
  const search = useDocumentSearch(documentRef, query, findOpen && searchable);

  useEffect(() => {
    if (!isImage) return;
    let disposed = false;
    let fallback: HTMLImageElement | null = null;
    setImageSize(null);
    setView(null);

    const decodeWithImage = () => {
      fallback = new Image();
      fallback.addEventListener(
        'load',
        () => {
          if (!disposed && fallback) {
            setImageSize({
              width: fallback.naturalWidth,
              height: fallback.naturalHeight,
            });
          }
        },
        { once: true },
      );
      fallback.src = url;
    };

    if (typeof createImageBitmap === 'function') {
      void createImageBitmap(blob)
        .then((bitmap) => {
          if (!disposed) setImageSize({ width: bitmap.width, height: bitmap.height });
          bitmap.close();
        })
        .catch(decodeWithImage);
    } else {
      decodeWithImage();
    }

    return () => {
      disposed = true;
      if (fallback) fallback.src = '';
    };
  }, [blob, isImage, url]);

  const fit = useCallback(() => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !imageSize) return;
    const available = {
      width: Math.max(1, box.width - FIT_PADDING * 2),
      height: Math.max(1, box.height - FIT_PADDING * 2),
    };
    const k = clamp(
      Math.min(available.width / imageSize.width, available.height / imageSize.height, 1),
    );
    setView({
      x: (box.width - imageSize.width * k) / 2,
      y: (box.height - imageSize.height * k) / 2,
      k,
    });
  }, [imageSize]);

  useLayoutEffect(fit, [fit]);

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
        // Escape backs out of the search first, the way it does in the reader.
        if (findOpen) {
          setFindOpen(false);
          setQuery('');
        } else {
          onClose();
        }
      } else if (searchable && event.key === 'f' && (event.metaKey || event.ctrlKey)) {
        setFindOpen(true);
      } else if (isImage && (event.key === '+' || event.key === '=')) {
        zoomAt(STEP);
      } else if (isImage && (event.key === '-' || event.key === '_')) {
        zoomAt(1 / STEP);
      } else if (isImage && event.key === '0') {
        fit();
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [findOpen, fit, isImage, onClose, searchable, zoomAt]);

  useEffect(() => {
    const element = stage.current;
    if (!isImage || !element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        if (gesture.current) return;
        const delta = Math.max(-40, Math.min(40, event.deltaY));
        zoomAt(
          Math.exp(-delta / 180),
          pointer.current ?? {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          },
        );
      } else {
        setView((current) =>
          current
            ? {
                ...current,
                x: current.x - event.deltaX,
                y: current.y - event.deltaY,
              }
            : current,
        );
      }
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const scale = 'scale' in event && typeof event.scale === 'number' ? event.scale : 1;
      gesture.current = {
        anchor: pointer.current ?? {
          x: element.clientWidth / 2,
          y: element.clientHeight / 2,
        },
        scale,
      };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const current = gesture.current;
      if (!current || !('scale' in event) || typeof event.scale !== 'number') return;
      zoomAt(event.scale / current.scale, current.anchor);
      current.scale = event.scale;
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gesture.current = null;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart, { passive: false });
    element.addEventListener('gesturechange', onGestureChange, { passive: false });
    element.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
      element.removeEventListener('gestureend', onGestureEnd);
    };
  }, [isImage, zoomAt]);

  function startPan(event: React.PointerEvent<HTMLElement>) {
    if (!isImage || event.button !== 0) return;
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

  async function saveOriginal() {
    setSaving(true);
    setStatus('');
    setError('');
    const outcome = await saveAttachmentCommand(attachment);
    setSaving(false);
    if (!outcome.ok) {
      if (outcome.code !== 'not_supported') setError(outcome.message);
      return;
    }
    setStatus(
      outcome.value
        ? t('editor.attachmentSavedAt', { path: outcome.value })
        : t('editor.attachmentSaved'),
    );
  }

  /** Close first: the conversion dialog would otherwise open behind a viewer
   * that covers the whole window. */
  function convertToNote() {
    onClose();
    beginAttachmentImportCommand({ kind: 'attachment', attachment });
  }

  return createPortal(
    <div
      className="nb-attachment-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
    >
      <header className="nb-map-viewer-bar">
        <h2 className="nb-map-viewer-title">{attachment.name}</h2>

        {isImage && (
          <div className="nb-map-viewer-controls">
            <button
              type="button"
              aria-label={t('mindMap.zoomOut')}
              title={t('mindMap.zoomOut')}
              onClick={() => zoomAt(1 / STEP)}
            >
              <Minus size={14} aria-hidden />
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
              <Plus size={14} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t('mindMap.fit')}
              title={t('mindMap.fit')}
              onClick={fit}
            >
              <Maximize2 size={14} aria-hidden />
            </button>
          </div>
        )}

        {searchable && (
          <div className="nb-map-viewer-controls">
            <button
              type="button"
              aria-pressed={findOpen}
              aria-label={t('find.placeholder')}
              title={t('find.placeholder')}
              onClick={() => setFindOpen((open) => !open)}
            >
              <Search size={14} aria-hidden />
            </button>
          </div>
        )}

        {/* Two groups, not two buttons in one: `nb-map-viewer-controls` draws
            the pill, and a shared pill reads as one segmented control — these
            are unrelated actions. */}
        {convertible && (
          <div className="nb-map-viewer-controls">
            <button type="button" onClick={convertToNote}>
              <FileOutput size={14} aria-hidden />
              {t('editor.convertAttachmentToNote')}
            </button>
          </div>
        )}

        <div className="nb-map-viewer-controls">
          <button type="button" disabled={saving} onClick={() => void saveOriginal()}>
            <Download size={14} aria-hidden />
            {t('editor.saveAttachment')}
          </button>
        </div>

        <span className="nb-attachment-viewer-kind" title={mime}>
          {attachmentKindLabel(attachment.name, mime) ?? t('editor.attachmentFile')}
        </span>
        <button
          type="button"
          className="nb-map-viewer-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      {findOpen && searchable && (
        <DocumentFindBar
          query={query}
          count={search.count}
          index={search.index}
          placeholder={t('find.placeholder')}
          onQuery={setQuery}
          onStep={search.step}
          onClose={() => {
            setFindOpen(false);
            setQuery('');
          }}
        />
      )}

      <main
        ref={stage}
        className={`nb-attachment-viewer-stage${isImage ? ' nb-attachment-image-stage' : ''}`}
        data-dragging={dragging || undefined}
        onPointerDown={startPan}
        onPointerMove={(event) => {
          if (!isImage) return;
          const box = event.currentTarget.getBoundingClientRect();
          pointer.current = {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          };
        }}
        onPointerLeave={() => {
          pointer.current = null;
        }}
        onDoubleClick={(event) => {
          if (!isImage) return;
          const box = event.currentTarget.getBoundingClientRect();
          zoomAt(STEP * STEP, {
            x: event.clientX - box.left,
            y: event.clientY - box.top,
          });
        }}
      >
        {isImage ? (
          <div
            className="nb-attachment-viewer-canvas"
            style={{
              transform: `translate(${view?.x ?? 0}px, ${view?.y ?? 0}px)`,
              visibility: view ? 'visible' : 'hidden',
            }}
          >
            <img
              src={url}
              alt={attachment.name}
              draggable={false}
              width={(imageSize?.width ?? 1) * (view?.k ?? 1)}
              height={(imageSize?.height ?? 1) * (view?.k ?? 1)}
              onLoad={(event) =>
                setImageSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          </div>
        ) : documentKind ? (
          <div ref={documentRef} className="nb-attachment-document">
            <AttachmentDocumentPreview blob={blob} kind={documentKind} />
          </div>
        ) : previewKind === 'audio' ? (
          <div className="nb-attachment-viewer-media">
            <audio controls preload="metadata" src={url} aria-label={attachment.name} />
          </div>
        ) : previewKind === 'video' ? (
          <div className="nb-attachment-viewer-media">
            <video controls preload="metadata" src={url} aria-label={attachment.name} />
          </div>
        ) : (
          <iframe src={url} title={attachment.name} sandbox="" />
        )}
      </main>

      {(isImage || status || error) && (
        <p
          className="nb-map-viewer-hint"
          data-tone={error ? 'danger' : undefined}
          aria-live="polite"
        >
          {error || status || t('mindMap.hint')}
        </p>
      )}
    </div>,
    document.body,
  );
}
