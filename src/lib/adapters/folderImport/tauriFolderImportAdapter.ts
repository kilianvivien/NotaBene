import { invoke } from '@tauri-apps/api/core';
import { decodeBase64 } from '@/lib/archive/base64';
import type { FolderImportAdapter, FolderManifest } from './FolderImportAdapter';

interface FolderFile {
  path: string;
  text?: string;
  data?: string;
}

/**
 * How much one `folder_read` asks for. Rust refuses a call over 96 MB, so the
 * batches stay well under it; the file-count cap keeps a folder of tiny notes
 * from becoming one enormous IPC message either.
 */
const BATCH_BYTES = 48 * 1024 * 1024;
const BATCH_FILES = 200;

function batches(paths: string[], sizes: Map<string, number>): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = sizes.get(path) ?? 0;
    if (current.length && (bytes + size > BATCH_BYTES || current.length >= BATCH_FILES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** File sizes from the last scan of each root, so reads can be batched by
 * bytes without the caller threading the manifest through. */
const knownSizes = new Map<string, Map<string, number>>();

export const tauriFolderImportAdapter: FolderImportAdapter = {
  supported: true,
  pickFolder: () => invoke<string | null>('folder_import_pick'),
  async scan(root) {
    const manifest = await invoke<FolderManifest>('folder_scan', { root });
    knownSizes.set(root, new Map(manifest.files.map((file) => [file.path, file.bytes])));
    return manifest;
  },
  async readText(root, paths) {
    const out = new Map<string, string>();
    for (const batch of batches(paths, knownSizes.get(root) ?? new Map())) {
      const files = await invoke<FolderFile[]>('folder_read', {
        root,
        paths: batch,
        text: true,
      });
      for (const file of files) out.set(file.path, file.text ?? '');
    }
    return out;
  },
  async readBytes(root, paths) {
    const out = new Map<string, Blob>();
    for (const batch of batches(paths, knownSizes.get(root) ?? new Map())) {
      const files = await invoke<FolderFile[]>('folder_read', {
        root,
        paths: batch,
        text: false,
      });
      for (const file of files) {
        out.set(file.path, new Blob([await decodeBase64(file.data ?? '')]));
      }
    }
    return out;
  },
};
