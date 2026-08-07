/** Asset store backed by the on-disk content-addressed directory in the app
 * data dir. Bytes travel as base64 over the IPC boundary; the Rust side owns
 * hashing and the sharded directory layout. */
import { invoke } from '@tauri-apps/api/core';
import type { Asset } from '@/lib/schema';
import { decodeBase64, encodeBlobBase64 } from '@/lib/archive/base64';
import type { AssetAdapter } from './AssetAdapter';

export const tauriAssetAdapter: AssetAdapter = {
  async put(bytes, meta) {
    return invoke<Asset>('assets_put', {
      data: await encodeBlobBase64(bytes),
      mime: meta?.mime ?? bytes.type ?? 'application/octet-stream',
    });
  },

  async get(assetId) {
    const payload = await invoke<{ data: string; mime: string } | null>('assets_get', {
      assetId,
    });
    return payload
      ? new Blob([await decodeBase64(payload.data)], { type: payload.mime })
      : null;
  },

  async urlFor(assetId) {
    const blob = await this.get(assetId);
    return blob ? URL.createObjectURL(blob) : null;
  },
  stat: (assetId: string) => invoke<Asset | null>('assets_stat', { assetId }),

  collectGarbage: () =>
    invoke<{ removed: number; bytes: number }>('assets_collect_garbage'),
};
