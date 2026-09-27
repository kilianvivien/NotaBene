/**
 * A Notion workspace export: a zip of Markdown pages.
 *
 * Notion names every page `Title 0123…cdef.md`, with the page's 32-hex id
 * welded onto the title, nests a page's children in a folder of the same
 * name, and URL-encodes every relative link. The id is the one stable thing
 * in all of that, so it becomes the `sourceKey`: renaming a page in Notion and
 * exporting again still finds the note imported last time.
 *
 * Handled: the common case. Refused, loudly: the HTML flavour of the export
 * (half-parsing HTML would be worse than saying so) and database CSVs, which
 * are tables, not notes — a CSV silently becoming a note is exactly the
 * failure to avoid. A database's *rows* are pages and do import.
 */
import { unzipFiles } from '@/lib/archive/zip';
import {
  basename,
  convertMarkdownNote,
  dirname,
  extensionOf,
  imageMime,
  isImagePath,
  isMarkdownPath,
  joinPath,
  stripExtension,
} from './markdownNote';
import {
  SourceRefusal,
  throwIfAborted,
  type ScanOptions,
  type SourceAttachment,
  type SourceImporter,
  type SourceNote,
  type SourceScan,
  type SourceSkip,
} from './SourceImporter';

/** A zip larger than this is not a notes export anyone wants in one go, and
 * unzipping holds all of it in memory at once. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
/** What the entries may expand to, together. */
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

const NOTION_ID = /\s+([0-9a-f]{32})$/i;

/** `Week 4 0123…cdef` → `{ title: 'Week 4', id: '0123…cdef' }`. */
export function notionName(name: string): { title: string; id: string | null } {
  const stem = stripExtension(name).replace(/\.csv$/i, '');
  const match = NOTION_ID.exec(stem);
  return match
    ? { title: stem.slice(0, match.index).trim() || stem, id: match[1]!.toLowerCase() }
    : { title: stem, id: null };
}

/**
 * The block of `Key: value` lines Notion writes under a page's title, turned
 * into frontmatter so the shared converter reads it like any other.
 * Only the properties a note has somewhere to put are kept.
 */
export function notionProperties(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  if (!/^#\s+/.test(lines[index] ?? '')) return markdown;
  index += 1;
  while (index < lines.length && !lines[index]!.trim()) index += 1;

  const properties: [string, string][] = [];
  const start = index;
  while (index < lines.length) {
    const match = /^([A-Za-zÀ-ÿ][\wÀ-ÿ ]{0,40}):\s+(.+)$/.exec(lines[index]!);
    if (!match) break;
    properties.push([match[1]!.trim().toLowerCase(), match[2]!.trim()]);
    index += 1;
  }
  if (!properties.length) return markdown;
  // The blank line that closed the block goes with it.
  while (index < lines.length && !lines[index]!.trim()) index += 1;

  const yaml: string[] = [];
  const quote = (value: string) => JSON.stringify(value);
  for (const [key, value] of properties) {
    if (key === 'tags' || key === 'tag' || key === 'étiquettes') {
      yaml.push(
        `tags: [${value
          .split(/\s*,\s*/)
          .filter(Boolean)
          .map(quote)
          .join(', ')}]`,
      );
    } else if (key === 'created' || key === 'created time' || key === 'date') {
      yaml.push(`created: ${quote(value)}`);
    } else if (key === 'last edited time' || key === 'updated') {
      yaml.push(`updated: ${quote(value)}`);
    } else if (key === 'author' || key === 'authors' || key === 'created by') {
      yaml.push(`author: ${quote(value.split(/\s*,\s*/).join('; '))}`);
    } else if (key === 'url' || key === 'source') {
      yaml.push(`source: ${quote(value)}`);
    }
  }
  const body = [...lines.slice(0, start), ...lines.slice(index)];
  return yaml.length
    ? `---\n${yaml.join('\n')}\n---\n${body.join('\n')}`
    : body.join('\n');
}

type Entries = Record<string, Uint8Array<ArrayBuffer>>;

function visible(path: string): boolean {
  return (
    !path.endsWith('/') &&
    !path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')
  );
}

/** Notion splits a large export into `Part-1.zip`, `Part-2.zip` inside the
 * outer archive. One level of that is unpacked; deeper nesting is not. */
async function expand(entries: Entries): Promise<Entries> {
  const paths = Object.keys(entries).filter(visible);
  if (!paths.length || !paths.every((path) => extensionOf(path) === 'zip'))
    return entries;
  const merged: Entries = {};
  for (const path of paths) {
    Object.assign(
      merged,
      await unzipFiles(entries[path]!, { maxBytes: MAX_EXPANDED_BYTES }),
    );
  }
  return merged;
}

/** Drop one wrapping folder that every entry shares — the export's own
 * container, which is not a page and should not become a course. */
function unwrap(paths: string[]): string {
  const first = paths[0]?.split('/')[0];
  if (!first || !paths.every((path) => path.startsWith(`${first}/`))) return '';
  return `${first}/`;
}

export function createNotionSource(
  readFile: (path: string) => Promise<Blob>,
): SourceImporter {
  return {
    id: 'notion',
    root: 'file',
    filters: [{ name: 'Notion export', extensions: ['zip'] }],
    available: () => true,
    async scan(root: string | null, options: ScanOptions = {}): Promise<SourceScan> {
      if (!root) throw new Error('a file is required');
      const blob = await readFile(root);
      if (blob.size > MAX_ARCHIVE_BYTES) throw new SourceRefusal('archiveTooLarge');
      throwIfAborted(options.signal);

      let entries: Entries;
      try {
        entries = await expand(
          await unzipFiles(new Uint8Array(await blob.arrayBuffer()), {
            maxBytes: MAX_EXPANDED_BYTES,
          }),
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new SourceRefusal(
          message.startsWith('too_large') ? 'archiveTooLarge' : 'notZip',
        );
      }
      throwIfAborted(options.signal);

      const all = Object.keys(entries).filter(visible);
      if (all.length > MAX_ENTRIES) throw new SourceRefusal('archiveTooLarge');
      const markdown = all.filter(isMarkdownPath);
      if (!markdown.length) {
        throw new SourceRefusal(
          all.some((path) => /\.html?$/i.test(path)) ? 'notionHtml' : 'notNotion',
        );
      }

      const prefix = unwrap(all);
      const relative = (path: string) => path.slice(prefix.length);
      const exact = new Map(all.map((path) => [relative(path).toLowerCase(), path]));

      const skipped: SourceSkip[] = [];
      for (const path of all) {
        if (isMarkdownPath(path) || isImagePath(path)) continue;
        skipped.push({
          path: relative(path),
          reason: extensionOf(path) === 'csv' ? 'database' : 'notMarkdown',
        });
      }

      const attachmentCache = new Map<string, SourceAttachment>();
      const attachment = (path: string): SourceAttachment => {
        const cached = attachmentCache.get(path);
        if (cached) return cached;
        const bytes = entries[path]!;
        const created: SourceAttachment = {
          key: path,
          name: basename(path),
          load: async () => new Blob([bytes], { type: imageMime(path) }),
        };
        attachmentCache.set(path, created);
        return created;
      };
      const locate = (from: string, href: string): string | null => {
        const joined = joinPath(dirname(relative(from)), href);
        return joined === null ? null : (exact.get(joined.toLowerCase()) ?? null);
      };

      const notes: SourceNote[] = [];
      for (const [index, path] of markdown.entries()) {
        if (index % 100 === 0) throwIfAborted(options.signal);
        const { title, id } = notionName(basename(path));
        const folders = dirname(relative(path))
          .split('/')
          .filter(Boolean)
          .map((folder) => notionName(folder).title);
        const text = new TextDecoder().decode(entries[path]!).replace(/^\uFEFF/, '');
        const note = convertMarkdownNote({
          path: relative(path),
          sourceKey: id ?? relative(path),
          text: notionProperties(text),
          flavour: 'notion',
          title,
          folders,
          resolveAttachment: (href) => {
            const found = locate(path, href);
            return found && isImagePath(found) ? attachment(found) : null;
          },
          resolveNoteLink: (href) => {
            const found = locate(path, href);
            // A link to a page resolves by path in the planner, like a folder.
            return found && isMarkdownPath(found) ? relative(found) : null;
          },
        });
        notes.push({ ...note, title: note.title || 'Untitled' });
        options.onProgress?.({ done: index + 1, total: markdown.length });
      }

      return {
        label: basename(root),
        notes,
        skipped,
        warnings: [],
      };
    },
  };
}
