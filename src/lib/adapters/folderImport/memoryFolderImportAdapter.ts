import type {
  FolderEntry,
  FolderImportAdapter,
  FolderManifest,
} from './FolderImportAdapter';

type Tree = Record<string, string | Uint8Array<ArrayBuffer>>;

/**
 * An in-memory folder, for tests and for the browser shell.
 *
 * The browser has no way to walk a directory the student picked, so the
 * default instance is `supported: false` and the importers it backs show as
 * unavailable. Tests build their own with `createMemoryFolderImportAdapter`,
 * which is what makes every reader unit-testable without a disk.
 */
export function createMemoryFolderImportAdapter(
  trees: Record<string, Tree> = {},
  options: { picked?: string | null; modifiedAt?: string } = {},
): FolderImportAdapter {
  const modifiedAt = options.modifiedAt ?? '2026-09-01T08:00:00.000Z';
  const tree = (root: string): Tree => {
    const found = trees[root];
    if (!found)
      throw new Error('not_picked:only a folder chosen in the import panel can be read');
    return found;
  };
  return {
    supported: Object.keys(trees).length > 0,
    async pickFolder() {
      return options.picked ?? Object.keys(trees)[0] ?? null;
    },
    async scan(root): Promise<FolderManifest> {
      const files: FolderEntry[] = Object.entries(tree(root))
        .filter(([path]) => !path.split('/').some((part) => part.startsWith('.')))
        .map(([path, content]) => ({
          path,
          bytes: typeof content === 'string' ? content.length : content.byteLength,
          modifiedAt,
          createdAt: modifiedAt,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { root, files, skipped: [], truncated: false };
    },
    async readText(root, paths) {
      const files = tree(root);
      return new Map(
        paths.map((path) => {
          const content = files[path];
          if (content === undefined) throw new Error(`not_found:${path}`);
          return [
            path,
            typeof content === 'string' ? content : new TextDecoder().decode(content),
          ];
        }),
      );
    },
    async readBytes(root, paths) {
      const files = tree(root);
      return new Map(
        paths.map((path) => {
          const content = files[path];
          if (content === undefined) throw new Error(`not_found:${path}`);
          return [path, new Blob([content])];
        }),
      );
    },
  };
}

export const memoryFolderImportAdapter = createMemoryFolderImportAdapter();
