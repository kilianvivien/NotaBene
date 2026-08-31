/**
 * Reading the scanned pages of a PDF, on this Mac.
 *
 * The second half of importing a scanned document. AnyDoc refuses a PDF
 * outright when any page is scanned — naming those pages, but returning no
 * text at all, because output missing them would read as complete. So this
 * renders exactly the named pages, recognises each, and hands them back to
 * the converter, which puts them among the pages AnyDoc could read.
 *
 * The loop is the whole design. Recognition is N short operations rather than
 * one long opaque one, so progress is an exact `page of total` and cancelling
 * is simply not starting the next page. There is no event protocol here and
 * no run registered in `aiStore`: nothing about this reaches a provider, and
 * putting it in the store that tracks provider calls would say otherwise.
 */
import { documentImporter, ocr, type OcrPageText } from '@/lib/adapters';
import type { DocumentImportSource } from '@/lib/import/documentImport';
import { rasterisePdfPages } from '@/lib/import/pdfPages';
import type { ImportedDocument } from '@/lib/schema';
import { sourceBytesCommand } from './importCommands';
import { fail, ok, type CommandResult } from './types';

export interface OcrProgress {
  /** How many pages have been read, including this one. */
  done: number;
  total: number;
}

export interface OcrRunOptions {
  signal?: AbortSignal;
  onProgress?(progress: OcrProgress): void;
  /** Empty means "detect the language from the page". */
  languages?: string[];
}

export interface OcrRunResult {
  document: ImportedDocument;
  /** Pages that were read and had text on them. */
  read: number;
  /** Pages that were read and turned out to be blank. Distinct from a
   *  failure: a blank scan is a real answer about the document. */
  blank: number;
}

/** Whether this build can read a scanned page at all. */
export async function ocrAvailableCommand(): Promise<boolean> {
  try {
    return await ocr.available();
  } catch {
    return false;
  }
}

/** The recognition languages this machine offers, best first. */
export async function ocrLanguagesCommand(): Promise<CommandResult<string[]>> {
  try {
    return ok(await ocr.languages());
  } catch (error) {
    return fail('not_supported', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Read `pages` of `bytes` and convert the whole PDF with them.
 *
 * Cancelling leaves nothing behind: no note is created here, no asset is
 * stored, and the recognised text is dropped with the returned result. The
 * note is still made by `createImportedNoteCommand`, from the document this
 * returns, exactly as an ordinary import is.
 */
export async function runOcrCommand(
  source: DocumentImportSource,
  pages: number[],
  options: OcrRunOptions = {},
): Promise<CommandResult<OcrRunResult>> {
  const { signal, onProgress, languages = [] } = options;
  if (!pages.length) return fail('invalid_input', 'ocr_no_pages');

  const read = await sourceBytesCommand(source);
  if (!read.ok) return read;
  const { bytes, filename } = read.value;

  const recognised: OcrPageText[] = [];
  let blank = 0;

  try {
    await rasterisePdfPages(
      bytes,
      pages,
      async ({ page, image }) => {
        const result = await ocr.recognizePage(image, languages);
        // A page with no lines on it is recorded as empty rather than
        // skipped, so the converter can tell "read, and blank" from "never
        // read" and warn about the right one.
        if (result.lines === 0 || !result.text.trim()) blank += 1;
        recognised.push({ page, text: result.text });
        onProgress?.({ done: recognised.length, total: pages.length });
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) return fail('invalid_input', 'cancelled');
    return fail('invalid_input', ocrFailure(error));
  }

  if (signal?.aborted) return fail('invalid_input', 'cancelled');

  try {
    const document = await documentImporter.extractPdfWithOcr(bytes, filename, recognised);
    return ok({ document, read: recognised.length - blank, blank });
  } catch (error) {
    return fail('invalid_input', ocrFailure(error));
  }
}

/** The `code:message` protocol the Rust side speaks, reduced to the code the
 *  surface has a message for. */
function ocrFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const code of ['not_supported', 'ocr_failed', 'malformed', 'read_failed'] as const) {
    if (message.includes(`${code}:`)) return code;
  }
  return 'ocr_failed';
}
