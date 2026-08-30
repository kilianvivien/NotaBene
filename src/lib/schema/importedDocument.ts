import { z } from 'zod';

/** NotaBene's stable boundary around AnyDoc's evolving Rust document model. */
export const ImportedDocumentFormatSchema = z.enum([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'odt',
  'ods',
  'odp',
  'epub',
  'rtf',
  'csv',
  'markdown',
  'text',
  'unknown',
]);

/** One embedded image, keyed by the id its `nb-import-asset:` placeholder
 *  carries so `materialiseAssets` can pair the two up. `data` is base64. */
export const ImportedAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  data: z.string(),
});

/**
 * What the conversion could not carry, as a code and a count.
 *
 * A code rather than a sentence: Rust cannot build a message that exists in
 * both locales, so the surface renders `import.warning.<code>` with the
 * count. Unknown codes are kept, not dropped — a version skew should show
 * something honest rather than nothing.
 */
export const ImportWarningSchema = z.object({
  code: z.string(),
  count: z.number().int().positive(),
});

/**
 * One page as text recognition read it, crossing IPC from Vision.
 *
 * Parsed rather than trusted like everything else that crosses a boundary:
 * `lines: 0` is the difference between "this scan was blank" and "something
 * went wrong", and the surface says different things about each.
 */
export const OcrPageSchema = z.object({
  text: z.string(),
  lines: z.number().int().nonnegative(),
  confidence: z.number(),
});

export const ImportedDocumentSchema = z.object({
  source: z.object({
    filename: z.string().min(1),
    format: ImportedDocumentFormatSchema,
  }),
  markdown: z.string(),
  assets: z.array(ImportedAssetSchema),
  metadata: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
    })
    .optional(),
  diagnostics: z.object({
    parser: z.enum(['anydoc', 'plain-text', 'ocr']),
    warnings: z.array(ImportWarningSchema),
    requiresOcr: z.boolean(),
  }),
});

export type ImportedDocument = z.infer<typeof ImportedDocumentSchema>;
export type ImportedAsset = z.infer<typeof ImportedAssetSchema>;
export type ImportWarning = z.infer<typeof ImportWarningSchema>;
export type ImportedDocumentFormat = z.infer<typeof ImportedDocumentFormatSchema>;
export type OcrPage = z.infer<typeof OcrPageSchema>;
