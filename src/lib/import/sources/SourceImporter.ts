/**
 * One importer, whatever app the notes come from.
 *
 * A reader's whole job is to turn someone else's files into `SourceNote`s in
 * NotaBene's Markdown dialect. Everything after that — deciding which course a
 * folder becomes, spotting a note imported last week, keeping titles unique,
 * pointing links at ids — is written once, in `plan.ts` and the command layer,
 * for every reader. That is why no reader knows about courses, and why none of
 * them writes anything: `scan` is a read, like `extractDocumentCommand`.
 *
 * Not an adapter: nothing here imports `@tauri-apps/*`. The folder readers
 * reach the disk through `FolderImportAdapter`, which is passed in, so each is
 * testable against an in-memory tree.
 */
import type { ImportWarning, TagNamespace } from '@/lib/schema';

/** In the order the dialog offers them: Obsidian first, because it is the
 * closest fit and the most common library a researcher arrives with. */
export const SOURCE_IDS = ['obsidian', 'markdownFolder', 'notion', 'appleNotes'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** A picture a note refers to, read only when the import is applied — a vault
 * can hold gigabytes of images, and the preview needs none of them. */
export interface SourceAttachment {
  /** Stable within a scan, so an image used by forty notes is stored once. */
  key: string;
  name: string;
  load(): Promise<Blob>;
}

export interface SourceTag {
  namespace: TagNamespace | null;
  name: string;
}

export interface SourceNote {
  /** Stable within a source across scans: the identity half of `importKey`.
   * A path for a folder, Notion's page id for Notion. */
  sourceKey: string;
  /** Shown to the student as where the note came from. */
  displayPath: string;
  title: string;
  /**
   * NotaBene's dialect, with Obsidian-style wiki links (`[[target|alias]]`)
   * whose targets are titles or source paths, and images already rewritten to
   * `![alt](asset:<key>)` with `<key>` in `attachments`.
   */
  markdown: string;
  /** Outermost first; the mapping step turns these into a course and section. */
  folders: string[];
  tags: SourceTag[];
  /** Other names a link may use for this note — Obsidian's `aliases`. */
  aliases: string[];
  createdAt?: string;
  updatedAt?: string;
  attachments: Map<string, SourceAttachment>;
  warnings: ImportWarning[];
}

export interface SourceSkip {
  path: string;
  /** A code for `importSource.skip.<reason>`: `notMarkdown`, `database`, … */
  reason: string;
}

export interface SourceScan {
  /** The folder or file the notes came from, for the dialog's header. */
  label: string;
  notes: SourceNote[];
  skipped: SourceSkip[];
  /** Whole-source warnings, each a code and a count. */
  warnings: ImportWarning[];
}

export interface ScanProgress {
  done: number;
  total: number;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?(progress: ScanProgress): void;
}

export interface SourceImporter {
  readonly id: SourceId;
  /** What the student picks: a folder, a single file, or nothing at all. */
  readonly root: 'folder' | 'file' | 'none';
  readonly filters?: { name: string; extensions: string[] }[];
  /** False stays visible and disabled, never hidden. */
  available(): boolean;
  scan(root: string | null, options?: ScanOptions): Promise<SourceScan>;
}

/** Thrown by a reader for a source it recognises and refuses — a Notion HTML
 * export, a zip that is not a Notion export at all. `code` is translated at
 * the surface, as `importSource.error.<code>`. */
export class SourceRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SourceRefusal';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
}

/** Add to a code's count, keeping one entry per code. */
export function warn(warnings: ImportWarning[], code: string, count = 1): void {
  if (count <= 0) return;
  const existing = warnings.find((warning) => warning.code === code);
  if (existing) existing.count += count;
  else warnings.push({ code, count });
}
