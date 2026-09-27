/**
 * A folder of Markdown files — the reference reader, and the base of Obsidian.
 *
 * The two differ only in how forgiving they are about where a picture or a
 * note lives. A plain folder means what it says: a relative path, or a path
 * from the folder's root. Obsidian also finds `![[figure.png]]` and `[[Week 4]]`
 * by name anywhere in the vault, preferring the shallowest match — which is
 * what Obsidian itself does, so a vault imports the way it looked.
 */
import type { FolderEntry, FolderImportAdapter } from '@/lib/adapters';
import {
  basename,
  convertMarkdownNote,
  dirname,
  imageMime,
  isImagePath,
  isMarkdownPath,
  joinPath,
  stripExtension,
  type MarkdownFlavour,
} from './markdownNote';
import {
  throwIfAborted,
  warn,
  type ScanOptions,
  type SourceAttachment,
  type SourceId,
  type SourceImporter,
  type SourceNote,
  type SourceScan,
  type SourceSkip,
} from './SourceImporter';

/** Files read per `readText` call: small enough that progress moves and
 * cancel is prompt, large enough that IPC overhead does not dominate. */
const READ_BATCH = 100;

/** Shallowest first, then alphabetical — the order Obsidian resolves an
 * ambiguous name in. */
export function byDepth(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || a.localeCompare(b);
}

function indexByName(
  paths: string[],
  key: (path: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const path of [...paths].sort(byDepth)) {
    const name = key(path).toLowerCase();
    index.set(name, [...(index.get(name) ?? []), path]);
  }
  return index;
}

export function createFolderSource(
  id: Extract<SourceId, 'markdownFolder' | 'obsidian'>,
  adapter: () => FolderImportAdapter,
): SourceImporter {
  const flavour: MarkdownFlavour = id === 'obsidian' ? 'obsidian' : 'markdown';
  const byName = id === 'obsidian';

  return {
    id,
    root: 'folder',
    available: () => adapter().supported,
    async scan(root: string | null, options: ScanOptions = {}): Promise<SourceScan> {
      if (!root) throw new Error('a folder is required');
      const folder = adapter();
      const manifest = await folder.scan(root);
      throwIfAborted(options.signal);

      const skipped: SourceSkip[] = manifest.skipped.map((skip) => ({ ...skip }));
      const warnings: SourceScan['warnings'] = [];
      if (manifest.truncated) warn(warnings, 'scanTruncated');

      const notes: FolderEntry[] = [];
      const images: FolderEntry[] = [];
      for (const file of manifest.files) {
        // The Excalidraw plugin stores drawings as Markdown wrapped around a
        // JSON blob. Imported as text it is a wall of noise, not a drawing.
        if (/\.excalidraw\.md$/i.test(file.path)) {
          skipped.push({ path: file.path, reason: 'excalidraw' });
        } else if (isMarkdownPath(file.path)) {
          notes.push(file);
        } else if (isImagePath(file.path)) {
          images.push(file);
        } else {
          skipped.push({ path: file.path, reason: 'notMarkdown' });
        }
      }

      const notePaths = new Map(
        notes.map((file) => [file.path.toLowerCase(), file.path]),
      );
      const imagePaths = new Map(
        images.map((file) => [file.path.toLowerCase(), file.path]),
      );
      const notesByName = indexByName(
        notes.map((file) => file.path),
        (path) => stripExtension(basename(path)),
      );
      const imagesByName = indexByName(
        images.map((file) => file.path),
        basename,
      );

      const attachmentCache = new Map<string, SourceAttachment>();
      const attachment = (path: string): SourceAttachment => {
        const cached = attachmentCache.get(path);
        if (cached) return cached;
        const created: SourceAttachment = {
          key: path,
          name: basename(path),
          async load() {
            const bytes = (await folder.readBytes(root, [path])).get(path);
            if (!bytes) throw new Error(`not_found:${path}`);
            return new Blob([bytes], { type: imageMime(path) });
          },
        };
        attachmentCache.set(path, created);
        return created;
      };

      /** A reference as written, to a path we were given — or nothing. */
      const locate = (
        from: string,
        href: string,
        exact: Map<string, string>,
        names: Map<string, string[]>,
        nameOf: (path: string) => string,
      ): string | null => {
        const candidates = [
          joinPath(dirname(from), href),
          joinPath('', href.replace(/^\/+/, '')),
        ];
        for (const candidate of candidates) {
          const found =
            candidate !== null ? exact.get(candidate.toLowerCase()) : undefined;
          if (found) return found;
        }
        if (byName) return names.get(nameOf(href).toLowerCase())?.[0] ?? null;
        return null;
      };

      const read: SourceNote[] = [];
      for (let start = 0; start < notes.length; start += READ_BATCH) {
        throwIfAborted(options.signal);
        const batch = notes.slice(start, start + READ_BATCH);
        const texts = await folder.readText(
          root,
          batch.map((file) => file.path),
        );
        for (const file of batch) {
          const path = file.path;
          read.push(
            convertMarkdownNote({
              path,
              text: texts.get(path) ?? '',
              flavour,
              title: stripExtension(basename(path)),
              folders: dirname(path).split('/').filter(Boolean),
              fileDates: { createdAt: file.createdAt, updatedAt: file.modifiedAt },
              resolveAttachment: (href) => {
                const found = locate(path, href, imagePaths, imagesByName, basename);
                return found ? attachment(found) : null;
              },
              resolveNoteLink: (href) => {
                const withExtension = isMarkdownPath(href) ? href : `${href}.md`;
                return locate(path, withExtension, notePaths, notesByName, (value) =>
                  stripExtension(basename(value)),
                );
              },
            }),
          );
        }
        options.onProgress?.({
          done: Math.min(start + READ_BATCH, notes.length),
          total: notes.length,
        });
      }

      return {
        label: basename(manifest.root) || manifest.root,
        notes: read,
        skipped,
        warnings,
      };
    },
  };
}
