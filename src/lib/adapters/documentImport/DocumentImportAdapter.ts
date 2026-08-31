import type { ImportedDocument } from '@/lib/schema';

/** Recognised text for one page of a PDF, on its way back to the converter.
 *  `page` is 1-indexed, matching how the conversion failure names pages. */
export interface OcrPageText {
  page: number;
  text: string;
}

/** Deterministic extraction only. Note creation remains in the command layer. */
export interface DocumentImportAdapter {
  extractBytes(bytes: Blob, filename: string): Promise<ImportedDocument>;
  /**
   * Convert a PDF whose scanned pages have since been read.
   *
   * Separate from `extractBytes` because it can only be reached after an
   * `ocr_required` failure the student answered. The converter goes page by
   * page and puts `pages` back among the ones it could read itself — which is
   * the whole point, since a single scanned page makes the normal path refuse
   * the entire document rather than return text with a hole in it.
   */
  extractPdfWithOcr(
    bytes: Blob,
    filename: string,
    pages: OcrPageText[],
  ): Promise<ImportedDocument>;
}
