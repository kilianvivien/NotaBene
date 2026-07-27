/** In-memory blob store for tests and the browser dev shell. */
import type { Asset } from '@/lib/schema';
import type { AssetAdapter } from './AssetAdapter';

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
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

class MemoryAssetAdapter implements AssetAdapter {
  private blobs = new Map<string, Blob>();
  private metas = new Map<string, Asset>();
  private urls = new Map<string, string>();

  async put(bytes: Blob, meta?: { mime?: string }): Promise<Asset> {
    const id = await sha256(await readBlob(bytes));
    const existing = this.metas.get(id);
    if (existing) return existing;

    const asset: Asset = {
      id,
      mime: meta?.mime ?? bytes.type ?? 'application/octet-stream',
      bytes: bytes.size,
      createdAt: new Date().toISOString(),
    };
    this.blobs.set(id, bytes);
    this.metas.set(id, asset);
    return asset;
  }

  async get(assetId: string): Promise<Blob | null> {
    return this.blobs.get(assetId) ?? null;
  }

  async urlFor(assetId: string): Promise<string | null> {
    const cached = this.urls.get(assetId);
    if (cached) return cached;
    const blob = this.blobs.get(assetId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(assetId, url);
    return url;
  }

  async stat(assetId: string): Promise<Asset | null> {
    return this.metas.get(assetId) ?? null;
  }

  async collectGarbage(referencedIds: Set<string>): Promise<number> {
    let removed = 0;
    for (const id of [...this.metas.keys()]) {
      if (referencedIds.has(id)) continue;
      const url = this.urls.get(id);
      if (url) URL.revokeObjectURL(url);
      this.urls.delete(id);
      this.blobs.delete(id);
      this.metas.delete(id);
      removed += 1;
    }
    return removed;
  }
}

export const memoryAssetAdapter: AssetAdapter = new MemoryAssetAdapter();
