import type { Attachment } from '@/lib/schema';

export const DOCUMENT_IMPORT_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'docm',
  'ppt',
  'pptx',
  'pptm',
  'pps',
  'ppsx',
  'ppsm',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'odt',
  'ods',
  'odp',
  'epub',
  'rtf',
  'csv',
  'md',
  'markdown',
  'txt',
] as const;

const IMPORT_EXTENSION_SET = new Set<string>(DOCUMENT_IMPORT_EXTENSIONS);

export function documentImportSupported(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return IMPORT_EXTENSION_SET.has(extension);
}

export function pathFilename(path: string): string {
  return path.split(/[\\/]/).pop() || 'document';
}

export type DocumentImportSource =
  | { kind: 'path'; path: string; name: string }
  | { kind: 'attachment'; attachment: Attachment };
