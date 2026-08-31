/**
 * Rendering a PDF page to an image, for text recognition.
 *
 * The rasteriser stays in TypeScript, on `pdfjs-dist`, which the attachment
 * viewer already ships. Doing it in Rust would mean a second untrusted-input
 * PDF parser inside the process that holds the library — the one thing plan
 * §11 is already uneasy about — to save a canvas.
 */
import { loadPdfjs } from '@/lib/pdf/loadPdfjs';

/**
 * Roughly 150 dpi against a US Letter page at pdfjs's 72 dpi unit.
 *
 * Vision reads a page at this size comfortably; below about 1.5 it starts
 * dropping small type, and above about 3 each page costs more to encode and
 * carry across IPC than the accuracy is worth.
 */
const RENDER_SCALE = 2;

/**
 * Ceiling on either dimension, in pixels. A poster-sized page at
 * `RENDER_SCALE` would otherwise allocate a canvas the webview refuses, and
 * a refused canvas is an unreadable page.
 */
const MAX_EDGE = 4000;

/**
 * JPEG, and not by preference.
 *
 * A canvas is RGBA, so `toBlob` with no type writes an RGBA PNG — and Vision
 * returns *no observations and no error* for an image with an alpha channel.
 * A perfectly legible page comes back blank. JPEG has no alpha channel by
 * construction, so it cannot reintroduce the problem, and it is several times
 * smaller to carry as base64. `src-tauri/src/ocr/vision.rs` refuses an alpha
 * PNG loudly in case this ever changes here.
 */
const IMAGE_TYPE = 'image/jpeg';

/** High enough that recognition sees clean glyph edges. Text is what JPEG
 *  compresses worst, so this is not the place to save bytes. */
const IMAGE_QUALITY = 0.92;

export interface RasterisedPage {
  /** 1-indexed, as the page list from the conversion failure counts. */
  page: number;
  image: Blob;
}

/** How many pages the document has, without rendering any of them. */
export async function pdfPageCount(bytes: Blob): Promise<number> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await bytes.arrayBuffer()) });
  const document = await task.promise;
  try {
    return document.numPages;
  } finally {
    await task.destroy();
  }
}

/**
 * Render the named pages, one at a time, handing each to `onPage` as it is
 * ready.
 *
 * A callback rather than an array: a hundred page images held at once is tens
 * of megabytes of canvas, and the caller recognises each page and discards it.
 * The PDF is parsed once for the whole run.
 *
 * `signal` is checked between pages — the granularity that matters, since one
 * page renders in well under a second.
 */
export async function rasterisePdfPages(
  bytes: Blob,
  pages: number[],
  onPage: (page: RasterisedPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await bytes.arrayBuffer()) });
  const document = await task.promise;
  try {
    for (const page of pages) {
      if (signal?.aborted) return;
      if (page < 1 || page > document.numPages) continue;
      const image = await renderPage(document, page);
      if (signal?.aborted) return;
      await onPage({ page, image });
    }
  } finally {
    await task.destroy();
  }
}

async function renderPage(
  document: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>,
  page: number,
): Promise<Blob> {
  const pdfPage = await document.getPage(page);
  const unscaled = pdfPage.getViewport({ scale: 1 });
  const fit = Math.min(
    RENDER_SCALE,
    MAX_EDGE / Math.max(unscaled.width, unscaled.height),
  );
  const viewport = pdfPage.getViewport({ scale: Math.max(1, fit) });

  const canvas = globalThis.document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('conversion_failed:the page could not be rendered');

  // A PDF page has no background of its own; without this the sheet is
  // transparent, and JPEG would flatten it to black with black text on it.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await pdfPage.render({ canvas, viewport }).promise;
  const image = await toBlob(canvas);
  // The canvas is the largest thing this loop allocates and a hundred of them
  // would otherwise wait on the collector.
  canvas.width = 0;
  canvas.height = 0;
  return image;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('conversion_failed:the page could not be rendered')),
      IMAGE_TYPE,
      IMAGE_QUALITY,
    );
  });
}
