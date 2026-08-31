import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrPageText } from '@/lib/adapters';
import type { ImportedDocument, OcrPage } from '@/lib/schema';

/**
 * The rasteriser and the recogniser are both replaced here, so what is under
 * test is the loop between them: which pages are read, in what order, what is
 * reported while it runs, and what survives a cancellation.
 *
 * Vision itself is not testable in a unit — it needs the framework and a real
 * page image. `src-tauri/src/ocr/vision.rs` carries a probe for that, run with
 * `NB_OCR_PROBE`, and plan §16 has the manual row.
 */
const recognizePage = vi.fn<(image: Blob, languages: string[]) => Promise<OcrPage>>();
const extractPdfWithOcr =
  vi.fn<(bytes: Blob, name: string, pages: OcrPageText[]) => Promise<ImportedDocument>>();
const available = vi.fn();
const languages = vi.fn();

/** Pages the fake PDF is deemed to have. */
let rendered: number[] = [];

// Spread the real module rather than replacing it: `@/lib/adapters` is the
// single export point for every adapter, so a bare factory would take
// `DEFAULT_SETTINGS` and the library adapter down with it.
vi.mock('@/lib/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adapters')>()),
  ocr: {
    available: (...args: unknown[]) => available(...args),
    languages: (...args: unknown[]) => languages(...args),
    recognizePage: (image: Blob, langs: string[]) => recognizePage(image, langs),
  },
  documentImporter: {
    extractPdfWithOcr: (bytes: Blob, name: string, pages: OcrPageText[]) =>
      extractPdfWithOcr(bytes, name, pages),
  },
  dialog: { readFile: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }) },
}));

vi.mock('@/lib/import/pdfPages', () => ({
  rasterisePdfPages: async (
    _bytes: Blob,
    pages: number[],
    onPage: (page: { page: number; image: Blob }) => Promise<void>,
    signal?: AbortSignal,
  ) => {
    for (const page of pages) {
      if (signal?.aborted) return;
      rendered.push(page);
      await onPage({ page, image: new Blob(['jpeg'], { type: 'image/jpeg' }) });
    }
  },
}));

const { runOcrCommand, ocrAvailableCommand } = await import('./ocrCommands');

const source = { kind: 'path', path: '/tmp/scan.pdf', name: 'scan.pdf' } as const;

const converted: ImportedDocument = {
  source: { filename: 'scan.pdf', format: 'pdf' },
  markdown: '# Read',
  assets: [],
  metadata: { title: 'scan' },
  diagnostics: { parser: 'ocr', warnings: [], requiresOcr: false },
};

function page(text: string, lines = 1): OcrPage {
  return { text, lines, confidence: 0.9 };
}

beforeEach(() => {
  rendered = [];
  vi.clearAllMocks();
  available.mockResolvedValue(true);
  extractPdfWithOcr.mockResolvedValue(converted);
  recognizePage.mockResolvedValue(page('Recognised'));
});

describe('runOcrCommand', () => {
  it('reads only the pages that were named, not the whole document', async () => {
    // The reason the page list is carried across IPC at all: a 200-page PDF
    // with three scanned pages costs three recognitions, not two hundred.
    const result = await runOcrCommand(source, [1, 5, 7]);

    expect(result.ok).toBe(true);
    expect(rendered).toEqual([1, 5, 7]);
    expect(recognizePage).toHaveBeenCalledTimes(3);
  });

  it('hands every recognised page back under its own number', async () => {
    recognizePage
      .mockResolvedValueOnce(page('page five'))
      .mockResolvedValueOnce(page('page seven'));

    await runOcrCommand(source, [5, 7]);

    expect(extractPdfWithOcr).toHaveBeenCalledWith(expect.anything(), 'scan.pdf', [
      { page: 5, text: 'page five' },
      { page: 7, text: 'page seven' },
    ]);
  });

  it('counts progress up in order, ending at the total', async () => {
    const seen: string[] = [];
    await runOcrCommand(source, [2, 4, 6], {
      onProgress: ({ done, total }) => seen.push(`${done}/${total}`),
    });
    expect(seen).toEqual(['1/3', '2/3', '3/3']);
  });

  it('reports a page that was read and blank without calling it a failure', async () => {
    // A scan of a blank sheet is a true answer about the document. Reporting
    // it as an error would send someone looking for a bug in the import.
    recognizePage
      .mockResolvedValueOnce(page('Real text'))
      .mockResolvedValueOnce(page('', 0));

    const result = await runOcrCommand(source, [1, 2]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.read).toBe(1);
    expect(result.value.blank).toBe(1);
  });

  it('treats whitespace as blank rather than as text', async () => {
    recognizePage.mockResolvedValue(page('   \n  ', 2));
    const result = await runOcrCommand(source, [1]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.blank).toBe(1);
  });

  it('cancelling stops the loop and converts nothing', async () => {
    // Nothing is written anywhere in this command, so cancelling has nothing
    // to undo — but it must also not go on to build a document out of the
    // half of the pages it managed to read.
    const controller = new AbortController();
    recognizePage.mockImplementation(async () => {
      controller.abort();
      return page('first');
    });

    const result = await runOcrCommand(source, [1, 2, 3], {
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(rendered).toEqual([1]);
    expect(extractPdfWithOcr).not.toHaveBeenCalled();
  });

  it('passes the chosen language through, and nothing when none was chosen', async () => {
    await runOcrCommand(source, [1], { languages: ['fr-FR'] });
    expect(recognizePage).toHaveBeenLastCalledWith(expect.anything(), ['fr-FR']);

    await runOcrCommand(source, [1]);
    expect(recognizePage).toHaveBeenLastCalledWith(expect.anything(), []);
  });

  it('refuses an empty page list rather than converting the PDF again for nothing', async () => {
    const result = await runOcrCommand(source, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('ocr_no_pages');
    expect(extractPdfWithOcr).not.toHaveBeenCalled();
  });

  it('reduces a recognition failure to a code the surface has a message for', async () => {
    recognizePage.mockRejectedValue(
      new Error('ocr_failed:the page image has an alpha channel'),
    );
    const result = await runOcrCommand(source, [1]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('ocr_failed');
  });

  it('says a build without recognition cannot do it, rather than throwing', async () => {
    available.mockRejectedValue(new Error('not_supported:needs the desktop app'));
    expect(await ocrAvailableCommand()).toBe(false);
  });
});
