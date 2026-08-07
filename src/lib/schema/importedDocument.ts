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

export const ImportedAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  data: z.string(),
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
    parser: z.enum(['anydoc', 'plain-text']),
    warnings: z.array(z.string()),
    requiresOcr: z.boolean(),
  }),
});

export type ImportedDocument = z.infer<typeof ImportedDocumentSchema>;
export type ImportedDocumentFormat = z.infer<typeof ImportedDocumentFormatSchema>;
