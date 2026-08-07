import type { ImportedDocument } from '@/lib/schema';

/** Deterministic extraction only. Note creation remains in the command layer. */
export interface DocumentImportAdapter {
  extractBytes(bytes: Blob, filename: string): Promise<ImportedDocument>;
}
