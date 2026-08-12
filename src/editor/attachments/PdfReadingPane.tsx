import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Highlighter,
  Maximize2,
  MessageSquareText,
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
import { useTranslation } from 'react-i18next';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextLayer,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { assets } from '@/lib/adapters';
import { extractPdfAnnotationCommand, savePdfAnnotationsCommand } from '@/lib/commands';
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

const COLORS: PdfAnnotationColor[] = ['yellow', 'green', 'blue', 'pink'];

function countOccurrences(text: string, query: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = text.indexOf(query, cursor)) >= 0) {
    count += 1;
    cursor += Math.max(1, query.length);
  }
  return count;
}

function annotationStyle(rect: PdfAnnotationRect, viewport: PageViewport): CSSProperties {
  const first = viewport.convertToViewportPoint(rect.x1, rect.y1);
  const second = viewport.convertToViewportPoint(rect.x2, rect.y2);
  const left = Math.min(first[0], second[0]);
  const top = Math.min(first[1], second[1]);
  return {
    left,
    top,
    width: Math.abs(second[0] - first[0]),
    height: Math.abs(second[1] - first[1]),
  };
}

function selectedRects(
  selection: Selection,
  pageElement: HTMLElement,
  viewport: PageViewport,
): PdfAnnotationRect[] {
  if (selection.rangeCount === 0 || selection.isCollapsed) return [];
  const pageBox = pageElement.getBoundingClientRect();
  const rects: PdfAnnotationRect[] = [];
  for (const clientRect of selection.getRangeAt(0).getClientRects()) {
    const left = Math.max(pageBox.left, clientRect.left);
    const top = Math.max(pageBox.top, clientRect.top);
    const right = Math.min(pageBox.right, clientRect.right);
    const bottom = Math.min(pageBox.bottom, clientRect.bottom);
    if (right - left < 1 || bottom - top < 1) continue;
    const a = viewport.convertToPdfPoint(left - pageBox.left, top - pageBox.top);
    const b = viewport.convertToPdfPoint(right - pageBox.left, bottom - pageBox.top);
    rects.push({
      x1: Math.min(a[0], b[0]),
      y1: Math.min(a[1], b[1]),
      x2: Math.max(a[0], b[0]),
      y2: Math.max(a[1], b[1]),
    });
  }
  return rects;
}

export function PdfReadingPane({ request }: { request: PdfReadingRequest }) {
  const { t } = useTranslation();
  const close = useUiStore((state) => state.closePdfReader);
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const frameRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const textCache = useRef(new Map<number, string>());
  const [attachment, setAttachment] = useState<Attachment>(request.attachment);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(request.page);
  const [zoom, setZoom] = useState(1);
  const [frameWidth, setFrameWidth] = useState(0);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [color, setColor] = useState<PdfAnnotationColor>('yellow');
  const [selectedId, setSelectedId] = useState<string | null>(
    request.annotationId ?? null,
  );
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number[]>([]);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);

  const selected = attachment.annotations.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    setAttachment(request.attachment);
    setPage(request.page);
    setSelectedId(request.annotationId ?? null);
  }, [request]);

  useEffect(() => {
    setComment(selected?.comment ?? '');
  }, [selected?.comment, selected?.id]);

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const update = () => setFrameWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    textCache.current.clear();
    setDocument(null);
    setError('');
    void (async () => {
      try {
        const blob = await assets.get(request.attachment.assetId);
        if (!blob) throw new Error(t('pdf.missingFile'));
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          data: new Uint8Array(await blob.arrayBuffer()),
        });
        const loaded = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        setDocument(loaded);
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
    if (!document || !canvasRef.current || !textLayerRef.current || !frameWidth) return;
    let disposed = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    setPending(null);
    setError('');
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (disposed || !canvasRef.current || !textLayerRef.current) return;
        const unscaled = pdfPage.getViewport({ scale: 1 });
        const fitScale = Math.min(Math.max(0.2, (frameWidth - 56) / unscaled.width), 1.8);
        const nextViewport = pdfPage.getViewport({ scale: fitScale * zoom });
        viewportRef.current = nextViewport;
        setViewport(nextViewport);
        const outputScale = window.devicePixelRatio || 1;
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
        const textContainer = textLayerRef.current;
        textContainer.replaceChildren();
        textContainer.style.setProperty('--scale-factor', String(nextViewport.scale));
        textContainer.style.setProperty(
          '--total-scale-factor',
          String(nextViewport.scale),
        );
        const pdfjs = await import('pdfjs-dist');
        textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: textContainer,
          viewport: nextViewport,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
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
  }, [document, frameWidth, page, zoom]);

  useEffect(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!document || !normalized) {
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
        for (let index = 1; index <= document.numPages; index += 1) {
          if (disposed) return;
          let text = textCache.current.get(index);
          if (text === undefined) {
            const pdfPage = await document.getPage(index);
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
  }, [document, query]);

  const moveMatch = useCallback(
    (direction: -1 | 1) => {
      if (!matches.length) return;
      const next = (matchIndex + direction + matches.length) % matches.length;
      setMatchIndex(next);
      setPage(matches[next] ?? page);
    },
    [matchIndex, matches, page],
  );

  function captureSelection() {
    const selection = window.getSelection();
    const pageElement = pageRef.current;
    const currentViewport = viewportRef.current;
    if (!selection || !pageElement || !currentViewport) return;
    const text = selection.toString().trim();
    const rects = selectedRects(selection, pageElement, currentViewport);
    setPending(text && rects.length ? { text, rects } : null);
  }

  async function persist(next: PdfAnnotation[]) {
    setSaving(true);
    const result = await savePdfAnnotationsCommand(attachment, next);
    if (result.ok) setAttachment(result.value);
    else setError(result.message);
    setSaving(false);
    return result.ok;
  }

  async function addHighlight() {
    if (!pending || readOnly) return;
    const now = new Date().toISOString();
    const annotation: PdfAnnotation = {
      id: newId(),
      page,
      rects: pending.rects,
      text: pending.text,
      comment: '',
      color,
      createdAt: now,
      updatedAt: now,
    };
    if (await persist([...attachment.annotations, annotation])) {
      setSelectedId(annotation.id);
      setPending(null);
      window.getSelection()?.removeAllRanges();
    }
  }

  async function saveComment() {
    if (!selected || readOnly) return;
    const next = attachment.annotations.map((annotation) =>
      annotation.id === selected.id
        ? { ...annotation, comment, updatedAt: new Date().toISOString() }
        : annotation,
    );
    await persist(next);
  }

  async function removeAnnotation(annotation: PdfAnnotation) {
    if (readOnly) return;
    if (
      await persist(attachment.annotations.filter((item) => item.id !== annotation.id))
    ) {
      setSelectedId(null);
    }
  }

  return (
    <aside className="nb-pdf-reader" aria-label={t('pdf.reader')}>
      <header className="nb-pdf-reader-header">
        <div>
          <strong title={attachment.name}>{attachment.name}</strong>
          <span>{t('pdf.reader')}</span>
        </div>
        <button type="button" aria-label={t('common.close')} onClick={close}>
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="nb-pdf-reader-toolbar">
        <button
          type="button"
          disabled={!document || page <= 1}
          aria-label={t('editor.previousPage')}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft size={15} aria-hidden />
        </button>
        <span>
          {document ? t('editor.pageCount', { page, count: document.numPages }) : '–'}
        </span>
        <button
          type="button"
          disabled={!document || page >= document.numPages}
          aria-label={t('editor.nextPage')}
          onClick={() =>
            setPage((current) => Math.min(document?.numPages ?? current, current + 1))
          }
        >
          <ChevronRight size={15} aria-hidden />
        </button>
        <span className="nb-pdf-reader-divider" aria-hidden />
        <button
          type="button"
          aria-label={t('mindMap.zoomOut')}
          onClick={() => setZoom((current) => Math.max(0.5, current / 1.2))}
        >
          <Minus size={14} aria-hidden />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label={t('mindMap.zoomIn')}
          onClick={() => setZoom((current) => Math.min(3, current * 1.2))}
        >
          <Plus size={14} aria-hidden />
        </button>
        <button type="button" aria-label={t('mindMap.fit')} onClick={() => setZoom(1)}>
          <Maximize2 size={14} aria-hidden />
        </button>
      </div>
      <div className="nb-pdf-reader-search">
        <Search size={14} aria-hidden />
        <input
          value={query}
          type="search"
          placeholder={t('pdf.search')}
          aria-label={t('pdf.search')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') moveMatch(event.shiftKey ? -1 : 1);
          }}
        />
        <span>
          {searching
            ? t('pdf.searching')
            : query.trim()
              ? t('pdf.matchCount', {
                  current: matchIndex >= 0 ? matchIndex + 1 : 0,
                  count: matches.length,
                })
              : ''}
        </span>
        <button
          type="button"
          disabled={!matches.length}
          aria-label={t('pdf.previousMatch')}
          onClick={() => moveMatch(-1)}
        >
          <ChevronUp size={14} aria-hidden />
        </button>
        <button
          type="button"
          disabled={!matches.length}
          aria-label={t('pdf.nextMatch')}
          onClick={() => moveMatch(1)}
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
      <div className="nb-pdf-reader-body">
        <div ref={frameRef} className="nb-pdf-reader-stage">
          {!document && !error && (
            <div className="nb-pdf-reader-state">{t('pdf.loading')}</div>
          )}
          {error && (
            <div className="nb-pdf-reader-state" data-tone="danger" role="alert">
              {error}
            </div>
          )}
          <div
            ref={pageRef}
            className="nb-pdf-reader-page"
            style={
              viewport ? { width: viewport.width, height: viewport.height } : undefined
            }
            onPointerUp={captureSelection}
          >
            <canvas ref={canvasRef} aria-label={t('editor.pdfPage', { page })} />
            <div ref={textLayerRef} className="textLayer nb-pdf-text-layer" />
            {viewport && (
              <div className="nb-pdf-annotation-layer" aria-label={t('pdf.annotations')}>
                {attachment.annotations
                  .filter((annotation) => annotation.page === page)
                  .flatMap((annotation) =>
                    annotation.rects.map((rect, index) => (
                      <button
                        key={`${annotation.id}-${index}`}
                        type="button"
                        data-color={annotation.color}
                        data-selected={annotation.id === selectedId || undefined}
                        style={annotationStyle(rect, viewport)}
                        aria-label={t('pdf.openAnnotation', { text: annotation.text })}
                        onClick={() => setSelectedId(annotation.id)}
                      />
                    )),
                  )}
              </div>
            )}
          </div>
        </div>
        <section className="nb-pdf-annotation-rail" aria-label={t('pdf.annotations')}>
          <div className="nb-pdf-highlight-actions">
            <div className="nb-pdf-colors" aria-label={t('pdf.highlightColor')}>
              {COLORS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  data-color={candidate}
                  data-selected={color === candidate || undefined}
                  aria-label={t(`pdf.color.${candidate}`)}
                  onClick={() => setColor(candidate)}
                />
              ))}
            </div>
            <button
              type="button"
              className="nb-pdf-primary-action"
              disabled={!pending || saving || readOnly}
              onClick={() => void addHighlight()}
            >
              <Highlighter size={14} aria-hidden />
              {t('pdf.addHighlight')}
            </button>
            <p>{pending ? pending.text : t('pdf.selectionHint')}</p>
          </div>
          <div className="nb-pdf-annotation-list">
            <h3>
              <MessageSquareText size={14} aria-hidden />
              {t('pdf.annotations')}
            </h3>
            {attachment.annotations.length === 0 ? (
              <p>{t('pdf.noAnnotations')}</p>
            ) : (
              attachment.annotations.map((annotation) => (
                <button
                  key={annotation.id}
                  type="button"
                  data-selected={annotation.id === selectedId || undefined}
                  onClick={() => {
                    setPage(annotation.page);
                    setSelectedId(annotation.id);
                  }}
                >
                  <span data-color={annotation.color} />
                  <span>{annotation.text}</span>
                  <small>{t('pdf.pageShort', { page: annotation.page })}</small>
                </button>
              ))
            )}
          </div>
          {selected && (
            <div className="nb-pdf-annotation-editor">
              <label htmlFor="nb-pdf-comment">{t('pdf.comment')}</label>
              <textarea
                id="nb-pdf-comment"
                value={comment}
                disabled={readOnly}
                placeholder={t('pdf.commentPlaceholder')}
                onChange={(event) => setComment(event.target.value)}
              />
              <div>
                <button
                  type="button"
                  disabled={saving || readOnly || comment === selected.comment}
                  onClick={() => void saveComment()}
                >
                  {t('common.save')}
                </button>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => extractPdfAnnotationCommand(attachment, selected)}
                >
                  <Quote size={13} aria-hidden />
                  {t('pdf.extractToNote')}
                </button>
                <button
                  type="button"
                  disabled={saving || readOnly}
                  aria-label={t('pdf.deleteHighlight')}
                  onClick={() => void removeAnnotation(selected)}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
