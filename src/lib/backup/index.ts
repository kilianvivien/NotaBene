import { strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import { assets } from '@/lib/adapters';
import { safeImportLibrary, type Library } from '@/lib/schema';
import { unzipFiles, zipFiles } from '@/lib/archive/zip';

const BackupManifestSchema = z.object({
  format: z.literal('notabene-backup'),
  formatVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  appVersion: z.string(),
  schemaVersion: z.number().int().positive(),
  libraryPath: z.literal('library.json'),
  /**
   * SHA-256 of the exact `library.json` bytes. Optional because archives
   * written before this field existed are still restorable — Zod objects ignore
   * unknown keys in both directions, so `formatVersion` stays 1 and an older
   * build reads a newer archive unharmed. Every asset was already
   * content-addressed; the library was the one thing nobody checked, so a
   * corrupted-but-still-parseable `library.json` used to restore silently.
   */
  librarySha256: z.string().optional(),
  assets: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      mime: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Assets the library references but whose bytes were not on disk when the
   * archive was written. Naming them is what lets the backup succeed anyway.
   */
  missingAssets: z.array(z.string()).default([]),
  counts: z.object({
    courses: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    assets: z.number().int().nonnegative(),
    snapshots: z.number().int().nonnegative(),
  }),
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface CreatedBackup {
  blob: Blob;
  /** Asset ids the archive could not include. Empty in the healthy case. */
  missingAssets: string[];
}

export interface ParsedBackup {
  manifest: BackupManifest;
  library: Library;
  assetBlobs: Map<string, Blob>;
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  // Copied into a freshly allocated buffer: `strToU8` and `unzipSync` hand back
  // views over `ArrayBufferLike`, which `crypto.subtle` will not take because it
  // could be a `SharedArrayBuffer`.
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function digest(blob: Blob): Promise<string> {
  return digestBytes(new Uint8Array(await blobBytes(blob)));
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer), {
      once: true,
    });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

function assertReferences(library: Library): void {
  const courseIds = new Set(library.courses.map((entry) => entry.id));
  const sectionIds = new Set(library.sections.map((entry) => entry.id));
  const noteIds = new Set(library.notes.map((entry) => entry.id));
  const tagIds = new Set(library.tags.map((entry) => entry.id));
  const assetIds = new Set(library.assets.map((entry) => entry.id));
  const invalid =
    library.sections.find((entry) => !courseIds.has(entry.courseId)) ??
    library.notes.find(
      (entry) =>
        (entry.courseId !== null && !courseIds.has(entry.courseId)) ||
        (entry.sectionId !== null && !sectionIds.has(entry.sectionId)) ||
        entry.tagIds.some((id) => !tagIds.has(id)),
    ) ??
    library.attachments.find(
      (entry) => !noteIds.has(entry.noteId) || !assetIds.has(entry.assetId),
    ) ??
    library.snapshots.find((entry) => !noteIds.has(entry.noteId)) ??
    library.templates.find(
      (entry) =>
        (entry.courseId !== null && !courseIds.has(entry.courseId)) ||
        entry.tagIds.some((id) => !tagIds.has(id)),
    );
  if (invalid) throw new Error('Backup contains broken entity references');
}

export async function createBackupArchive(library: Library): Promise<CreatedBackup> {
  const libraryBytes = strToU8(JSON.stringify(library, null, 2));
  const files: Record<string, Uint8Array> = { 'library.json': libraryBytes };
  const manifest: BackupManifest = {
    format: 'notabene-backup',
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: library.appVersion,
    schemaVersion: library.schemaVersion,
    libraryPath: 'library.json',
    librarySha256: await digestBytes(libraryBytes),
    assets: [],
    missingAssets: [],
    counts: {
      courses: library.courses.length,
      notes: library.notes.length,
      assets: library.assets.length,
      snapshots: library.snapshots.length,
    },
  };

  for (const asset of library.assets) {
    // A blob that cannot be read no longer takes the whole backup down with
    // it. One orphaned row used to mean *every* future backup failed, which
    // traded a note with a broken image for no backup at all — the wrong way
    // round. The id is recorded so restore can say what came back incomplete.
    const blob = await assets.get(asset.id).catch(() => null);
    if (!blob) {
      manifest.missingAssets.push(asset.id);
      continue;
    }
    const path = `assets/${asset.id.slice(0, 2)}/${asset.id}`;
    files[path] = new Uint8Array(await blobBytes(blob));
    manifest.assets.push({
      id: asset.id,
      path,
      mime: asset.mime,
      bytes: blob.size,
    });
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return {
    blob: new Blob([await zipFiles(files)], {
      type: 'application/x-notabene-backup',
    }),
    missingAssets: manifest.missingAssets,
  };
}

export async function parseBackupArchive(blob: Blob): Promise<ParsedBackup> {
  let files: Record<string, Uint8Array>;
  try {
    files = await unzipFiles(new Uint8Array(await blobBytes(blob)));
  } catch {
    throw new Error('The selected file is not a valid NotaBene backup');
  }
  const manifestBytes = files['manifest.json'];
  const libraryBytes = files['library.json'];
  if (!manifestBytes || !libraryBytes) {
    throw new Error('Backup is missing its manifest or library');
  }

  const manifest = BackupManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
  // Only when the archive carries one: older backups predate the field, and
  // refusing them would turn a hardening change into data loss.
  if (
    manifest.librarySha256 &&
    (await digestBytes(libraryBytes)) !== manifest.librarySha256
  ) {
    throw new Error('Backup library failed integrity validation');
  }
  const imported = safeImportLibrary(JSON.parse(strFromU8(libraryBytes)));
  if (!imported.ok) throw new Error(imported.error);
  assertReferences(imported.library);

  const assetBlobs = new Map<string, Blob>();
  for (const entry of manifest.assets) {
    const bytes = files[entry.path];
    if (!bytes) throw new Error(`Backup is missing asset ${entry.id}`);
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const asset = new Blob([data], { type: entry.mime });
    if (asset.size !== entry.bytes || (await digest(asset)) !== entry.id) {
      throw new Error(`Backup asset ${entry.id} failed integrity validation`);
    }
    assetBlobs.set(entry.id, asset);
  }
  return { manifest, library: imported.library, assetBlobs };
}
