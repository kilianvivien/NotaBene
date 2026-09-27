import { dialog, folderImporter } from '@/lib/adapters';
import { createFolderSource } from './folderSource';
import { createNotionSource } from './notionSource';
import type { SourceId, SourceImporter } from './SourceImporter';

export * from './SourceImporter';
export {
  planSourceImport,
  importKeyFor,
  type ExistingPolicy,
  type ImportPlan,
  type PlannedNote,
} from './plan';

/** Every importer, in the order the dialog offers them. */
export const SOURCE_IMPORTERS: Record<SourceId, SourceImporter> = {
  obsidian: createFolderSource('obsidian', () => folderImporter),
  markdownFolder: createFolderSource('markdownFolder', () => folderImporter),
  notion: createNotionSource((path) => dialog.readFile(path)),
};
