/** Asset store backed by the on-disk content-addressed directory in the app
 * data dir. Bytes travel as base64 over the IPC boundary; the Rust side owns
 * hashing and the sharded directory layout. */
import { invoke } from '@tauri-apps/api/core';
import type { Asset } from '@/lib/schema';
import type { AssetAdapter } from './AssetAdapter';

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked so a large slide deck does not blow the argument limit.
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

export const tauriAssetAdapter: AssetAdapter = {
  async put(bytes, meta) {
    return invoke<Asset>('assets_put', {
      data: await toBase64(bytes),
      mime: meta?.mime ?? bytes.type ?? 'application/octet-stream',
    });
  },

  async get(assetId) {
    const payload = await invoke<{ data: string; mime: string } | null>('assets_get', {
      assetId,
    });
    return payload ? fromBase64(payload.data, payload.mime) : null;
  },

  async urlFor(assetId) {
    const blob = await this.get(assetId);
    return blob ? URL.createObjectURL(blob) : null;
  },
  stat: (assetId: string) => invoke<Asset | null>('assets_stat', { assetId }),

  collectGarbage: (referencedIds: Set<string>) =>
    invoke<number>('assets_collect_garbage', { referencedIds: [...referencedIds] }),
};
