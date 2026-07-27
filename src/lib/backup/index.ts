import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { assets } from '@/lib/adapters';
import { safeImportLibrary, type Library } from '@/lib/schema';

const BackupManifestSchema = z.object({
  format: z.literal('notabene-backup'),
  formatVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  appVersion: z.string(),
  schemaVersion: z.number().int().positive(),
  libraryPath: z.literal('library.json'),
  assets: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
      mime: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  counts: z.object({
    courses: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    assets: z.number().int().nonnegative(),
    snapshots: z.number().int().nonnegative(),
  }),
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface ParsedBackup {
  manifest: BackupManifest;
  library: Library;
  assetBlobs: Map<string, Blob>;
}

async function digest(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await blobBytes(blob));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

export async function createBackupArchive(library: Library): Promise<Blob> {
  const files: Record<string, Uint8Array> = {
    'library.json': strToU8(JSON.stringify(library, null, 2)),
  };
  const manifest: BackupManifest = {
    format: 'notabene-backup',
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: library.appVersion,
    schemaVersion: library.schemaVersion,
    libraryPath: 'library.json',
    assets: [],
    counts: {
      courses: library.courses.length,
      notes: library.notes.length,
      assets: library.assets.length,
      snapshots: library.snapshots.length,
    },
  };

  for (const asset of library.assets) {
    const blob = await assets.get(asset.id);
    if (!blob) throw new Error(`Asset ${asset.id} is missing from disk`);
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
  return new Blob([zipSync(files, { level: 6 })], {
    type: 'application/x-notabene-backup',
  });
}

export async function parseBackupArchive(blob: Blob): Promise<ParsedBackup> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await blobBytes(blob)));
  } catch {
    throw new Error('The selected file is not a valid NotaBene backup');
  }
  const manifestBytes = files['manifest.json'];
  const libraryBytes = files['library.json'];
  if (!manifestBytes || !libraryBytes) {
    throw new Error('Backup is missing its manifest or library');
  }

  const manifest = BackupManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
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
