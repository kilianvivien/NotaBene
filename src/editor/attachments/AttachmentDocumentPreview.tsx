import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { AiRichText } from '@/app/ai/AiRichText';
import { loadPdfjs } from '@/lib/pdf/loadPdfjs';
import type { AttachmentPreviewKind } from '@/lib/attachments/previewSupport';
import { readAttachmentBuffer, readAttachmentText, rtfToText } from './documentPreview';
import { renderOdtHtml } from './odtPreview';

interface AttachmentDocumentPreviewProps {
  blob: Blob;
  kind: Extract<
    AttachmentPreviewKind,
    'pdf' | 'docx' | 'odt' | 'markdown' | 'rtf' | 'text'
  >;
}

function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="nb-document-preview-state" role="status">
      {t('editor.loadingAttachmentPreview')}
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  const { t } = useTranslation();
  return (
    <div className="nb-document-preview-state" data-tone="danger" role="alert">
      <strong>{t('editor.attachmentPreviewFailed')}</strong>
      <span>{error}</span>
    </div>
  );
}

function PdfPreview({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [frameWidth, setFrameWidth] = useState(0);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const element = frame.current;
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
    setDocument(null);
    setPage(1);
    setError('');

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await readAttachmentBuffer(blob));
        loadingTask = pdfjs.getDocument({ data });
        const loaded = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        setDocument(loaded);
      } catch (cause) {
        if (!disposed) setError(String(cause));
      }
    })();

    return () => {
      disposed = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  useEffect(() => {
    if (!document || !canvas.current || !frameWidth) return;
    let disposed = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (disposed || !canvas.current) return;
        const unscaled = pdfPage.getViewport({ scale: 1 });
        const fitScale = Math.min(Math.max(0.1, (frameWidth - 64) / unscaled.width), 1.6);
        const viewport = pdfPage.getViewport({ scale: fitScale * zoom });
        const outputScale = window.devicePixelRatio || 1;
        const target = canvas.current;
        target.width = Math.floor(viewport.width * outputScale);
        target.height = Math.floor(viewport.height * outputScale);
        target.style.width = `${Math.floor(viewport.width)}px`;
        target.style.height = `${Math.floor(viewport.height)}px`;
        renderTask = pdfPage.render({
          canvas: target,
          viewport,
          transform:
            outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
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
    };
  }, [document, frameWidth, page, zoom]);

  if (error) return <ErrorState error={error} />;

  return (
    <div ref={frame} className="nb-pdf-preview">
      <div className="nb-document-preview-controls">
        <button
          type="button"
          disabled={!document || page <= 1}
          aria-label={t('editor.previousPage')}
          title={t('editor.previousPage')}
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
          title={t('editor.nextPage')}
          onClick={() =>
            setPage((current) => Math.min(document?.numPages ?? current, current + 1))
          }
        >
          <ChevronRight size={15} aria-hidden />
        </button>
        <span className="nb-document-preview-separator" aria-hidden />
        <button
          type="button"
          aria-label={t('mindMap.zoomOut')}
          title={t('mindMap.zoomOut')}
          onClick={() => setZoom((current) => Math.max(0.5, current / 1.25))}
        >
          <Minus size={14} aria-hidden />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label={t('mindMap.zoomIn')}
          title={t('mindMap.zoomIn')}
          onClick={() => setZoom((current) => Math.min(3, current * 1.25))}
        >
          <Plus size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t('mindMap.fit')}
          title={t('mindMap.fit')}
          onClick={() => setZoom(1)}
        >
          <Maximize2 size={14} aria-hidden />
        </button>
      </div>
      {!document && <LoadingState />}
      <div className="nb-pdf-page">
        <canvas ref={canvas} aria-label={t('editor.pdfPage', { page })} />
      </div>
    </div>
  );
}

function AsyncDocument({
  load,
  children,
}: {
  load(): Promise<string>;
  children(content: string): ReactNode;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    setContent(null);
    setError('');
    void load()
      .then((value) => {
        if (!disposed) setContent(value);
      })
      .catch((cause) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [load]);

  if (error) return <ErrorState error={error} />;
  if (content === null) return <LoadingState />;
  return children(content);
}

function DocxPreview({ blob }: { blob: Blob }) {
  const container = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    let disposed = false;
    target.replaceChildren();
    setLoading(true);
    setError('');

    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        const data = await readAttachmentBuffer(blob);
        if (disposed) return;
        await renderAsync(data, target, target, {
          breakPages: true,
          experimental: true,
          ignoreHeight: false,
          ignoreLastRenderedPageBreak: false,
          ignoreWidth: false,
          inWrapper: true,
          renderAltChunks: false,
          renderEndnotes: true,
          renderFooters: true,
          renderFootnotes: true,
          renderHeaders: true,
          useBase64URL: true,
        });
        if (disposed) target.replaceChildren();
        else setLoading(false);
      } catch (cause) {
        if (!disposed) {
          setLoading(false);
          setError(String(cause));
        }
      }
    })();

    return () => {
      disposed = true;
      target.replaceChildren();
    };
  }, [blob]);

  if (error) return <ErrorState error={error} />;
  return (
    <div className="nb-docx-preview">
      {loading && <LoadingState />}
      <div ref={container} className="nb-docx-renderer" />
    </div>
  );
}

function OdtPreview({ blob }: { blob: Blob }) {
  const load = async () =>
    renderOdtHtml(new Uint8Array(await readAttachmentBuffer(blob)));

  return (
    <AsyncDocument load={load}>
      {(html) => (
        <article
          className="nb-document-paper nb-odt-preview"
          // renderOdtHtml builds this markup through DOM APIs from a strict tag,
          // attribute, URL, and CSS allowlist.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </AsyncDocument>
  );
}

function TextPreview({ blob, kind }: { blob: Blob; kind: 'markdown' | 'rtf' | 'text' }) {
  const load = async () => {
    const source = await readAttachmentText(blob);
    return kind === 'rtf' ? rtfToText(source) : source;
  };

  return (
    <AsyncDocument load={load}>
      {(content) => (
        <article className="nb-document-paper">
          {kind === 'markdown' ? (
            <AiRichText markdown={content} className="nb-markdown-preview" />
          ) : (
            <pre className="nb-plain-document-preview">{content}</pre>
          )}
        </article>
      )}
    </AsyncDocument>
  );
}

export function AttachmentDocumentPreview({
  blob,
  kind,
}: AttachmentDocumentPreviewProps) {
  if (kind === 'pdf') return <PdfPreview blob={blob} />;
  if (kind === 'docx') return <DocxPreview blob={blob} />;
  if (kind === 'odt') return <OdtPreview blob={blob} />;
  return <TextPreview blob={blob} kind={kind} />;
}
