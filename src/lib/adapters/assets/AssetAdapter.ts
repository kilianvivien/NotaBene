/**
 * Content-addressed blob store: images, drawing renders, attachment payloads,
 * generated audio.
 *
 * Addressing by content hash means pasting the same lecture slide into ten
 * notes costs one copy on disk, and a note that references an asset can never
 * point at bytes that quietly changed underneath it.
 */
import type { Asset } from '@/lib/schema';

export interface AssetAdapter {
  /** Store bytes and return the asset row. Idempotent: re-storing identical
   * bytes returns the existing asset rather than a duplicate. */
  put(bytes: Blob, meta?: { mime?: string }): Promise<Asset>;
  get(assetId: string): Promise<Blob | null>;
  /** A URL the webview can render (`blob:` in the browser, `asset:` under
   * Tauri). Callers must revoke browser URLs they no longer need. */
  urlFor(assetId: string): Promise<string | null>;
  stat(assetId: string): Promise<Asset | null>;
  /** Drop assets no durable document or attachment references any more. */
  collectGarbage(): Promise<{ removed: number; bytes: number }>;
}
