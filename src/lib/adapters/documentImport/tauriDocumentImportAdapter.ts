import { invoke } from '@tauri-apps/api/core';
import { encodeBlobBase64 } from '@/lib/archive/base64';
import { ImportedDocumentSchema, type ImportedDocument } from '@/lib/schema';
import type { DocumentImportAdapter } from './DocumentImportAdapter';

function parse(value: unknown): ImportedDocument {
  return ImportedDocumentSchema.parse(value);
}

export const tauriDocumentImportAdapter: DocumentImportAdapter = {
  async extractBytes(bytes, filename) {
    return parse(
      await invoke('document_import_bytes', {
        data: await encodeBlobBase64(bytes),
        filename,
      }),
    );
  },
};
