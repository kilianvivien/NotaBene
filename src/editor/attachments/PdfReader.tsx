/**
 * Full-window PDF reader and annotator.
 *
 * A PDF opens the way every other attachment does — edge to edge over the whole
 * window — because reading a handout in a column beside the note left neither
 * of them wide enough to be useful. The annotation surface is deliberately
 * quiet: colours appear beside the selection you just made, a highlight's note
 * opens on the highlight itself, and the list of highlights is a drawer you ask
 * for. The only permanent chrome is the header, which reads like the mind map
 * and image viewers.
 */
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileOutput,
  Highlighter,
  Maximize2,
  Minus,
  Plus,
  Quote,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextLayer,
} from 'pdfjs-dist';
import { assets } from '@/lib/adapters';
import { attachmentKindLabel } from '@/lib/attachments/previewSupport';
import { DocumentFindBar } from './DocumentFindBar';
import { clearDocumentMatches, paintDocumentMatches } from './useDocumentSearch';
import { loadPdfjs } from '@/lib/pdf/loadPdfjs';
import {
  beginAttachmentImportCommand,
  extractPdfAnnotationCommand,
  savePdfAnnotationsCommand,
  saveAttachmentCommand,
} from '@/lib/commands';
import {
  newId,
  type Attachment,
  type PdfAnnotation,
  type PdfAnnotationColor,
  type PdfAnnotationRect,
} from '@/lib/schema';
import type { PdfReadingRequest } from '@/lib/state/uiStore';
import { useUiStore } from '@/lib/state/uiStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';

type PageViewport = ReturnType<PDFPageProxy['getViewport']>;

interface PendingSelection {
  text: string;
  rects: PdfAnnotationRect[];
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const COLORS: PdfAnnotationColor[] = ['yellow', 'green', 'blue', 'pink'];
/** Stage padding on both sides, so a page fits the width it is actually given. */
const STAGE_PADDING = 72;
/** A popover placed above its anchor needs this much room, or it flips below. */
const POPOVER_HEADROOM = 96;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
/**
 * A page is drawn at the width it is given, up to this multiple of its natural
 * size. Rendering is vector, so the ceiling is about canvas memory rather than
 * sharpness — and a small page blown up past this stops reading like a page.
 */
const MAX_FIT_SCALE = 2.2;
/** Device pixels one page canvas may occupy; WebKit gives up well above this. */
const MAX_CANVAS_PIXELS = 12e6;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function countOccurrences(text: string, query: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(query, cursor)) >= 0) {
    count += 1;
    cursor += Math.max(1, query.length);
  }
  return count;
}

/** PDF user space to viewport pixels, for one rect or a whole selection. */
function viewportBox(rects: PdfAnnotationRect[], viewport: PageViewport): Box | null {
  let box: Box | null = null;
  for (const rect of rects) {
    const first = viewport.convertToViewportPoint(rect.x1, rect.y1);
    const second = viewport.convertToViewportPoint(rect.x2, rect.y2);
    const next = {
      left: Math.min(first[0], second[0]),
      top: Math.min(first[1], second[1]),
      right: Math.max(first[0], second[0]),
      bottom: Math.max(first[1], second[1]),
    };
    box = box
      ? {
          left: Math.min(box.left, next.left),
          top: Math.min(box.top, next.top),
          right: Math.max(box.right, next.right),
          bottom: Math.max(box.bottom, next.bottom),
        }
      : next;
  }
  return box;
}

function rectStyle(rect: PdfAnnotationRect, viewport: PageViewport): CSSProperties {
  const box = viewportBox([rect], viewport);
  if (!box) return {};
  return {
    left: box.left,
    top: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
  };
}

/**
 * Anchors a popover to the centre of a box, above it when there is room, and
 * keeps it over the page: a highlight in the margin would otherwise hang its
 * card off the edge, where the stage clips it.
 */
function popoverStyle(box: Box, pageWidth: number, halfWidth: number): CSSProperties {
  const centre = (box.left + box.right) / 2;
  const limit = Math.max(halfWidth + 8, pageWidth - halfWidth - 8);
  return {
    left: Math.min(Math.max(centre, halfWidth + 8), limit),
    top: box.top < POPOVER_HEADROOM ? box.bottom : box.top,
  };
}

function selectedRects(
  selection: Selection,
  pageElement: HTMLElement,
  viewport: PageViewport,
  previewScale: number,
): PdfAnnotationRect[] {
  if (selection.rangeCount === 0 || selection.isCollapsed) return [];
  const pageBox = pageElement.getBoundingClientRect();
  const rects: PdfAnnotationRect[] = [];
  // `Array.from`, not `for…of`: `DOMRectList` is not reliably iterable in the
  // WebKit build the desktop app runs on.
  for (const clientRect of Array.from(selection.getRangeAt(0).getClientRects())) {
    const left = Math.max(pageBox.left, clientRect.left);
    const top = Math.max(pageBox.top, clientRect.top);
    const right = Math.min(pageBox.right, clientRect.right);
    const bottom = Math.min(pageBox.bottom, clientRect.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    // Divided by the transient pinch scale, because that lives on the page's
    // transform and never on the viewport the rects are stored against.
    const a = viewport.convertToPdfPoint(
      (left - pageBox.left) / previewScale,
      (top - pageBox.top) / previewScale,
    );
    const b = viewport.convertToPdfPoint(
      (right - pageBox.left) / previewScale,
      (bottom - pageBox.top) / previewScale,
    );
    rects.push({
      x1: Math.min(a[0], b[0]),
      y1: Math.min(a[1], b[1]),
      x2: Math.max(a[0], b[0]),
      y2: Math.max(a[1], b[1]),
    });
  }
  return rects;
}

export function PdfReader({ request }: { request: PdfReadingRequest }) {
  const { t } = useTranslation();
  const close = useUiStore((state) => state.closePdfReader);
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const stageRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const textCache = useRef(new Map<number, string>());
  const [attachment, setAttachment] = useState<Attachment>(request.attachment);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(request.page);
  const [zoom, setZoom] = useState(1);
  /**
   * A pinch scales the page it already has and re-renders once the fingers
   * stop. Resizing the canvas per gesture frame would blank the page on every
   * one of them, which is the flicker this avoids.
   */
  const [previewScale, setPreviewScale] = useState(1);
  const previewRef = useRef(1);
  const commitTimer = useRef(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  /** Drawn, not merely measured — the page only shows once there is ink on it. */
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [selectable, setSelectable] = useState(true);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    request.annotationId ?? null,
  );
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number[]>([]);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);

  const selected = attachment.annotations.find((item) => item.id === selectedId) ?? null;
  const pageAnnotations = attachment.annotations.filter((item) => item.page === page);
  const kind = attachmentKindLabel(attachment.name, 'application/pdf');

  useEffect(() => {
    setAttachment(request.attachment);
    setPage(request.page);
    setSelectedId(request.annotationId ?? null);
  }, [request]);

  useEffect(() => {
    setComment(selected?.comment ?? '');
  }, [selected?.comment, selected?.id]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => setStageWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    textCache.current.clear();
    setPdf(null);
    setError('');
    void (async () => {
      try {
        const blob = await assets.get(request.attachment.assetId);
        if (!blob) throw new Error(t('pdf.missingFile'));
        const pdfjs = await loadPdfjs();
        loadingTask = pdfjs.getDocument({
          data: new Uint8Array(await blob.arrayBuffer()),
        });
        const loaded = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        setPdf(loaded);
        setPage((current) => Math.min(Math.max(1, current), loaded.numPages));
      } catch (cause) {
        if (!disposed) setError(String(cause));
      }
    })();
    return () => {
      disposed = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [request.attachment.assetId, t]);

  useEffect(() => {
    if (!pdf || !canvasRef.current || !textLayerRef.current || !stageWidth) return;
    let disposed = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    setPending(null);
    setError('');
    setRendered(false);
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (disposed || !canvasRef.current || !textLayerRef.current) return;
        const unscaled = pdfPage.getViewport({ scale: 1 });
        const fitScale = Math.min(
          Math.max(0.2, (stageWidth - STAGE_PADDING) / unscaled.width),
          MAX_FIT_SCALE,
        );
        const nextViewport = pdfPage.getViewport({ scale: fitScale * zoom });
        viewportRef.current = nextViewport;
        setViewport(nextViewport);
        const area = nextViewport.width * nextViewport.height;
        const outputScale = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_CANVAS_PIXELS / area),
        );
        const canvas = canvasRef.current;
        canvas.width = Math.floor(nextViewport.width * outputScale);
        canvas.height = Math.floor(nextViewport.height * outputScale);
        canvas.style.width = `${nextViewport.width}px`;
        canvas.style.height = `${nextViewport.height}px`;
        renderTask = pdfPage.render({
          canvas,
          viewport: nextViewport,
          transform:
            outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        const textContent = await pdfPage.getTextContent();
        textCache.current.set(
          page,
          textContent.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .toLocaleLowerCase(),
        );
        await renderTask.promise;
        if (disposed || !textLayerRef.current) return;
        setRendered(true);
        // The text layer is what makes a selection possible, and nothing more:
        // when it fails, the page is still perfectly readable, so it degrades
        // to "you cannot highlight here" instead of replacing the page with an
        // error.
        try {
          const textContainer = textLayerRef.current;
          textContainer.replaceChildren();
          textContainer.style.setProperty('--scale-factor', String(nextViewport.scale));
          textContainer.style.setProperty(
            '--total-scale-factor',
            String(nextViewport.scale),
          );
          const pdfjs = await loadPdfjs();
          textLayer = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: textContainer,
            viewport: nextViewport,
          });
          await textLayer.render();
          // A scanned page renders a text layer with nothing in it, which is
          // the same thing to a reader trying to highlight it.
          if (!disposed) setSelectable(textContent.items.length > 0);
        } catch (cause) {
          if (!disposed && (cause as { name?: string }).name !== 'AbortException') {
            setSelectable(false);
          }
        }
      } catch (cause) {
        if (
          !disposed &&
          (cause as { name?: string }).name !== 'RenderingCancelledException'
        ) {
          setError(String(cause));
        }
      }
    })();
    return () => {
      disposed = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, stageWidth, page, zoom]);

  /**
   * Matches are painted on the page that is showing. `matches` holds one entry
   * per hit, in page order, so the current hit's rank *within its page* is how
   * many earlier entries share that page.
   */
  useEffect(() => {
    if (!rendered || !findOpen) {
      clearDocumentMatches();
      return;
    }
    const onThisPage = matches.filter((candidate) => candidate === page).length;
    const current =
      matches[matchIndex] === page
        ? matches.slice(0, matchIndex).filter((candidate) => candidate === page).length
        : -1;
    if (onThisPage === 0) clearDocumentMatches();
    else paintDocumentMatches(textLayerRef.current, query, current);
  }, [findOpen, matchIndex, matches, page, query, rendered]);

  useEffect(() => clearDocumentMatches, []);

  /** A new page starts at its top, not wherever the last one was scrolled to. */
  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!pdf || !normalized) {
      setMatches([]);
      setMatchIndex(-1);
      setSearching(false);
      return;
    }
    let disposed = false;
    const timeout = window.setTimeout(() => {
      setSearching(true);
      void (async () => {
        const found: number[] = [];
        for (let index = 1; index <= pdf.numPages; index += 1) {
          if (disposed) return;
          let text = textCache.current.get(index);
          if (text === undefined) {
            const pdfPage = await pdf.getPage(index);
            const content = await pdfPage.getTextContent();
            text = content.items
              .map((item) => ('str' in item ? item.str : ''))
              .join(' ')
              .toLocaleLowerCase();
            textCache.current.set(index, text);
          }
          const count = countOccurrences(text, normalized);
          for (let hit = 0; hit < count; hit += 1) found.push(index);
        }
        if (disposed) return;
        setMatches(found);
        setMatchIndex(found.length ? 0 : -1);
        if (found[0]) setPage(found[0]);
        setSearching(false);
      })().catch((cause) => {
        if (!disposed) {
          setSearching(false);
          setError(String(cause));
        }
      });
    }, 250);
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [pdf, query]);

  const moveMatch = useCallback(
    (direction: -1 | 1) => {
      if (!matches.length) return;
      const next = (matchIndex + direction + matches.length) % matches.length;
      setMatchIndex(next);
      setPage(matches[next] ?? page);
    },
    [matchIndex, matches, page],
  );

  /** Zoom set outright, by a button: nothing transient survives it. */
  const applyZoom = useCallback((next: number) => {
    window.clearTimeout(commitTimer.current);
    previewRef.current = 1;
    setPreviewScale(1);
    setZoom(clampZoom(next));
  }, []);

  /** Zoom nudged by a pinch or a trackpad, committed once it settles. */
  const nudgeZoom = useCallback(
    (factor: number) => {
      setPreviewScale((current) => {
        const next = clampZoom(zoom * current * factor) / zoom;
        previewRef.current = next;
        return next;
      });
      window.clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(() => {
        setZoom((current) => clampZoom(current * previewRef.current));
        previewRef.current = 1;
        setPreviewScale(1);
      }, 200);
    },
    [zoom],
  );

  useEffect(() => () => window.clearTimeout(commitTimer.current), []);

  /** A confirmation is worth a moment, not the rest of the reading session. */
  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // A plain wheel scrolls the page, which is what a reader expects; only
      // the zoom gesture is intercepted.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = Math.max(-40, Math.min(40, event.deltaY));
      nudgeZoom(Math.exp(-delta / 180));
    };
    const gesture = { scale: 1 };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gesture.scale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (!('scale' in event) || typeof event.scale !== 'number') return;
      nudgeZoom(event.scale / gesture.scale);
      gesture.scale = event.scale;
    };
    const onGestureEnd = (event: Event) => event.preventDefault();
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
  }, [nudgeZoom]);

  const dismiss = useCallback(() => {
    if (pending) {
      setPending(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (selectedId) {
      setSelectedId(null);
      return;
    }
    if (findOpen) {
      setFindOpen(false);
      setQuery('');
      return;
    }
    close();
  }, [close, findOpen, pending, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Typing in the find field or a comment is not a reader shortcut, apart
      // from Escape, which backs out of whatever is open.
      const typing =
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
      if (event.key === 'Escape') {
        dismiss();
      } else if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
        setFindOpen(true);
      } else if (!typing && event.key === 'ArrowLeft') {
        setPage((current) => Math.max(1, current - 1));
      } else if (!typing && event.key === 'ArrowRight') {
        setPage((current) => Math.min(pdf?.numPages ?? current, current + 1));
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss, pdf]);

  const persist = useCallback(
    async (next: PdfAnnotation[]) => {
      setSaving(true);
      const result = await savePdfAnnotationsCommand(attachment, next);
      if (result.ok) setAttachment(result.value);
      else setError(result.message);
      setSaving(false);
      return result.ok;
    },
    [attachment],
  );

  function captureSelection() {
    const selection = window.getSelection();
    const pageElement = pageRef.current;
    const currentViewport = viewportRef.current;
    if (!selection || !pageElement || !currentViewport) return;
    const text = selection.toString().trim();
    const rects = selectedRects(
      selection,
      pageElement,
      currentViewport,
      previewRef.current,
    );
    if (!text || !rects.length) return;
    setSelectedId(null);
    setPending({ text, rects });
  }

  async function addHighlight(chosen: PdfAnnotationColor) {
    if (!pending || readOnly) return;
    const now = new Date().toISOString();
    const annotation: PdfAnnotation = {
      id: newId(),
      page,
      rects: pending.rects,
      text: pending.text,
      comment: '',
      color: chosen,
      createdAt: now,
      updatedAt: now,
    };
    if (await persist([...attachment.annotations, annotation])) {
      setPending(null);
      window.getSelection()?.removeAllRanges();
      setSelectedId(annotation.id);
    }
  }

  const updateAnnotation = useCallback(
    async (id: string, patch: Partial<PdfAnnotation>) => {
      const target = attachment.annotations.find((item) => item.id === id);
      if (!target || readOnly) return;
      await persist(
        attachment.annotations.map((item) =>
          item.id === id
            ? { ...item, ...patch, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
    },
    [attachment.annotations, persist, readOnly],
  );

  /** Comments autosave, the way note text does; blur only shortens the wait. */
  const flushComment = useCallback(() => {
    if (!selected || readOnly || comment === selected.comment) return;
    void updateAnnotation(selected.id, { comment });
  }, [comment, readOnly, selected, updateAnnotation]);

  useEffect(() => {
    if (!selected || readOnly || comment === selected.comment) return;
    const timeout = window.setTimeout(flushComment, 700);
    return () => window.clearTimeout(timeout);
  }, [comment, flushComment, readOnly, selected]);

  async function removeAnnotation(annotation: PdfAnnotation) {
    if (readOnly) return;
    if (
      await persist(attachment.annotations.filter((item) => item.id !== annotation.id))
    ) {
      setSelectedId(null);
    }
  }

  function extract(annotation: PdfAnnotation) {
    const result = extractPdfAnnotationCommand(attachment, annotation);
    if (result.ok) setStatus(t('pdf.extracted'));
    else if (result.code === 'not_supported') setStatus(t('pdf.extractFailed'));
    else setError(result.message);
  }

  async function saveOriginal() {
    setStatus('');
    const outcome = await saveAttachmentCommand(attachment);
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

  /** Close first: the conversion dialog would otherwise open behind a reader
   * that covers the whole window. */
  function convertToNote() {
    close();
    beginAttachmentImportCommand({ kind: 'attachment', attachment });
  }

  const pendingBox = pending && viewport ? viewportBox(pending.rects, viewport) : null;
  const selectedBox =
    selected && viewport && selected.page === page
      ? viewportBox(selected.rects, viewport)
      : null;

  return createPortal(
    <div
      className="nb-attachment-viewer nb-pdf-reader"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
    >
      <header className="nb-map-viewer-bar">
        <h2 className="nb-map-viewer-title">{attachment.name}</h2>

        <div className="nb-map-viewer-controls">
          <button
            type="button"
            disabled={!pdf || page <= 1}
            aria-label={t('editor.previousPage')}
            title={t('editor.previousPage')}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <span className="nb-map-viewer-scale" aria-live="polite">
            {pdf ? t('editor.pageCount', { page, count: pdf.numPages }) : '–'}
          </span>
          <button
            type="button"
            disabled={!pdf || page >= pdf.numPages}
            aria-label={t('editor.nextPage')}
            title={t('editor.nextPage')}
            onClick={() =>
              setPage((current) => Math.min(pdf?.numPages ?? current, current + 1))
            }
          >
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>

        <div className="nb-map-viewer-controls">
          <button
            type="button"
            aria-label={t('mindMap.zoomOut')}
            title={t('mindMap.zoomOut')}
            onClick={() => applyZoom(zoom / 1.2)}
          >
            <Minus size={14} aria-hidden />
          </button>
          <span className="nb-map-viewer-scale" aria-live="polite">
            {Math.round(zoom * previewScale * 100)}%
          </span>
          <button
            type="button"
            aria-label={t('mindMap.zoomIn')}
            title={t('mindMap.zoomIn')}
            onClick={() => applyZoom(zoom * 1.2)}
          >
            <Plus size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t('mindMap.fit')}
            title={t('mindMap.fit')}
            onClick={() => applyZoom(1)}
          >
            <Maximize2 size={14} aria-hidden />
          </button>
        </div>

        <div className="nb-map-viewer-controls">
          <button
            type="button"
            aria-pressed={findOpen}
            aria-label={t('pdf.search')}
            title={t('pdf.search')}
            onClick={() => setFindOpen((open) => !open)}
          >
            <Search size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-pressed={listOpen}
            aria-label={t('pdf.annotations')}
            title={t('pdf.annotations')}
            onClick={() => setListOpen((open) => !open)}
          >
            <Highlighter size={14} aria-hidden />
            {attachment.annotations.length > 0 && (
              <span className="nb-pdf-count">{attachment.annotations.length}</span>
            )}
          </button>
        </div>

        <div className="nb-map-viewer-controls">
          <button type="button" onClick={convertToNote}>
            <FileOutput size={14} aria-hidden />
            <span className="nb-pdf-action-label">
              {t('editor.convertAttachmentToNote')}
            </span>
          </button>
        </div>

        <div className="nb-map-viewer-controls">
          <button type="button" onClick={() => void saveOriginal()}>
            <Download size={14} aria-hidden />
            <span className="nb-pdf-action-label">{t('editor.saveAttachment')}</span>
          </button>
        </div>

        {kind && <span className="nb-attachment-viewer-kind">{kind}</span>}
        <button
          type="button"
          className="nb-map-viewer-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={close}
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      <div className="nb-pdf-reader-body">
        <div className="nb-pdf-stage-frame">
          {findOpen && (
            <DocumentFindBar
              query={query}
              count={matches.length}
              index={matchIndex}
              busy={searching}
              placeholder={t('pdf.search')}
              onQuery={setQuery}
              onStep={moveMatch}
              onClose={() => {
                setFindOpen(false);
                setQuery('');
              }}
            />
          )}

          <main
            ref={stageRef}
            className="nb-pdf-stage"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                setPending(null);
                setSelectedId(null);
              }
            }}
          >
            {!pdf && !error && <p className="nb-pdf-state">{t('pdf.loading')}</p>}
            {error && (
              <p className="nb-pdf-state" data-tone="danger" role="alert">
                {error}
              </p>
            )}
            <div
              ref={pageRef}
              className="nb-pdf-page"
              data-ready={viewport ? true : undefined}
              data-rendered={rendered || undefined}
              style={
                viewport
                  ? {
                      width: viewport.width,
                      height: viewport.height,
                      transform:
                        previewScale === 1 ? undefined : `scale(${previewScale})`,
                    }
                  : undefined
              }
              onPointerDown={(event) => {
                // Starting anywhere that is not a highlight or its card puts
                // the page back to plain reading — including starting a new
                // selection, which supersedes the last one anyway.
                const target = event.target as HTMLElement;
                if (target.closest('.nb-pdf-popover, .nb-pdf-annotation-layer')) return;
                setPending(null);
                setSelectedId(null);
              }}
              onPointerUp={captureSelection}
            >
              <canvas ref={canvasRef} aria-label={t('editor.pdfPage', { page })} />
              <div ref={textLayerRef} className="nb-pdf-text-layer" />
              {viewport && (
                <div
                  className="nb-pdf-annotation-layer"
                  aria-label={t('pdf.annotations')}
                >
                  {pageAnnotations.flatMap((annotation) =>
                    annotation.rects.map((rect, index) => (
                      <button
                        key={`${annotation.id}-${index}`}
                        type="button"
                        data-color={annotation.color}
                        data-selected={annotation.id === selectedId || undefined}
                        style={rectStyle(rect, viewport)}
                        aria-label={t('pdf.openAnnotation', { text: annotation.text })}
                        onClick={() => {
                          setPending(null);
                          setSelectedId(annotation.id);
                        }}
                      />
                    )),
                  )}
                </div>
              )}

              {pendingBox && !readOnly && (
                <div
                  className="nb-pdf-popover nb-pdf-swatches"
                  style={popoverStyle(pendingBox, viewport?.width ?? 0, 62)}
                  data-below={pendingBox.top < POPOVER_HEADROOM || undefined}
                >
                  <Highlighter size={13} aria-hidden />
                  {COLORS.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      disabled={saving}
                      data-color={candidate}
                      aria-label={t(`pdf.color.${candidate}`)}
                      title={t(`pdf.color.${candidate}`)}
                      onClick={() => void addHighlight(candidate)}
                    />
                  ))}
                </div>
              )}

              {selected && selectedBox && (
                <div
                  className="nb-pdf-popover nb-pdf-note"
                  style={popoverStyle(selectedBox, viewport?.width ?? 0, 139)}
                  data-below={selectedBox.top < POPOVER_HEADROOM || undefined}
                >
                  <div className="nb-pdf-note-colors">
                    {COLORS.map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        disabled={readOnly || saving}
                        data-color={candidate}
                        data-selected={selected.color === candidate || undefined}
                        aria-label={t(`pdf.color.${candidate}`)}
                        title={t(`pdf.color.${candidate}`)}
                        onClick={() =>
                          void updateAnnotation(selected.id, { color: candidate })
                        }
                      />
                    ))}
                    <span />
                    <button
                      type="button"
                      className="nb-pdf-note-action"
                      aria-label={t('pdf.extractToNote')}
                      title={t('pdf.extractToNote')}
                      // The comment being typed has not been persisted yet;
                      // the excerpt should carry what is on screen.
                      onClick={() => extract({ ...selected, comment })}
                    >
                      <Quote size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="nb-pdf-note-action"
                      disabled={readOnly || saving}
                      aria-label={t('pdf.deleteHighlight')}
                      title={t('pdf.deleteHighlight')}
                      onClick={() => void removeAnnotation(selected)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="nb-pdf-note-action"
                      aria-label={t('common.close')}
                      title={t('common.close')}
                      onClick={() => {
                        flushComment();
                        setSelectedId(null);
                      }}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </div>
                  <textarea
                    value={comment}
                    disabled={readOnly}
                    aria-label={t('pdf.comment')}
                    placeholder={t('pdf.commentPlaceholder')}
                    onChange={(event) => setComment(event.target.value)}
                    onBlur={flushComment}
                  />
                </div>
              )}
            </div>
          </main>
        </div>

        {listOpen && (
          <aside className="nb-pdf-highlights" aria-label={t('pdf.annotations')}>
            {attachment.annotations.length === 0 ? (
              <p className="nb-pdf-highlights-empty">{t('pdf.noAnnotations')}</p>
            ) : (
              <ul>
                {attachment.annotations.map((annotation) => (
                  <li key={annotation.id}>
                    <button
                      type="button"
                      data-selected={annotation.id === selectedId || undefined}
                      onClick={() => {
                        setPending(null);
                        setPage(annotation.page);
                        setSelectedId(annotation.id);
                      }}
                    >
                      <span data-color={annotation.color} aria-hidden />
                      <span className="nb-pdf-highlight-text">{annotation.text}</span>
                      <small>{t('pdf.pageShort', { page: annotation.page })}</small>
                      {annotation.comment && (
                        <em className="nb-pdf-highlight-note">{annotation.comment}</em>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>

      <p
        className="nb-map-viewer-hint"
        data-tone={error ? 'danger' : undefined}
        aria-live="polite"
      >
        {error || status || (selectable ? t('pdf.selectionHint') : t('pdf.noTextLayer'))}
      </p>
    </div>,
    document.body,
  );
}
