import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { installStreamAsyncIterator } from './streamAsyncIterator';

/**
 * The one way into `pdfjs`.
 *
 * Every caller needs the same two things done first — the WebKit stream shim
 * and the bundled worker URL — and a caller that forgets either fails only on
 * the desktop build, which is the last place anyone looks.
 */
export async function loadPdfjs() {
  installStreamAsyncIterator();
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjs;
}
