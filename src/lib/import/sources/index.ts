import { dialog, folderImporter } from '@/lib/adapters';
import { createFolderSource } from './folderSource';
import { createNotionSource } from './notionSource';
import { SourceRefusal, type SourceId, type SourceImporter } from './SourceImporter';

export * from './SourceImporter';
export {
  planSourceImport,
  importKeyFor,
  type ExistingPolicy,
  type ImportPlan,
  type PlannedNote,
} from './plan';

/**
 * Apple Notes has no export, and the AppleScript bridge that would read it
 * sits behind an Automation prompt and the entitlements §12 parked. It is
 * listed, and disabled, so its absence is a visible fact rather than a gap.
 */
const appleNotes: SourceImporter = {
  id: 'appleNotes',
  root: 'none',
  available: () => false,
  async scan() {
    throw new SourceRefusal('unavailable');
  },
};

/** Every importer, in the order the dialog offers them. */
export const SOURCE_IMPORTERS: Record<SourceId, SourceImporter> = {
  obsidian: createFolderSource('obsidian', () => folderImporter),
  markdownFolder: createFolderSource('markdownFolder', () => folderImporter),
  notion: createNotionSource((path) => dialog.readFile(path)),
  appleNotes,
};
