import { ImportedDocumentSchema, type ImportedDocument } from '@/lib/schema';
import type { DocumentImportAdapter } from './DocumentImportAdapter';

function format(filename: string): 'markdown' | 'text' {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'txt') return 'text';
  throw new Error('Document conversion requires the NotaBene desktop app');
}

async function extract(bytes: Blob, filename: string): Promise<ImportedDocument> {
  const markdown = await bytes.text();
  const parsed = ImportedDocumentSchema.parse({
    source: { filename, format: format(filename) },
    markdown,
    assets: [],
    metadata: { title: filename.replace(/\.[^.]+$/, '') },
    diagnostics: { parser: 'plain-text', warnings: [], requiresOcr: false },
  });
  return parsed;
}

export const memoryDocumentImportAdapter: DocumentImportAdapter = {
  extractBytes: extract,
};
