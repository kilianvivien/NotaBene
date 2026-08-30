import { beforeEach, describe, expect, it } from 'vitest';
import { assets } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import type { ImportedDocument } from '@/lib/schema';
import { materialiseAssets } from './importedAssets';

/** One-pixel PNG-ish payloads; only the bytes' identity matters here. */
const RED = btoa('red-bytes');
const BLUE = btoa('blue-bytes');

function document(
  markdown: string,
  files: { id: string; data: string }[],
): ImportedDocument {
  return {
    source: { filename: 'deck.pptx', format: 'pptx' },
    markdown,
    assets: files.map((file) => ({
      id: file.id,
      name: `image-${file.id}.png`,
      mime: 'image/png',
      data: file.data,
    })),
    metadata: { title: 'Deck' },
    diagnostics: { parser: 'anydoc', warnings: [], requiresOcr: false },
  };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('materialiseAssets', () => {
  it('points the placeholder at the stored asset', async () => {
    const result = await materialiseAssets(
      document('![Fig 1](asset:nb-import-0)', [{ id: '0', data: RED }]),
    );
    const [stored] = result.storedIds;
    expect(stored).toBeTruthy();
    expect(result.markdown).toBe(`![Fig 1](asset:${stored})`);
    expect(result.warnings).toEqual([]);
  });

  /**
   * The reason images are assets rather than attachments: `assets.put` is
   * keyed by the SHA-256 of the bytes, so a logo repeated on forty slides is
   * one blob and every placeholder resolves to the same id.
   */
  it('stores one blob for an image the document repeated', async () => {
    const result = await materialiseAssets(
      document(
        '![a](asset:nb-import-0)\n\n![b](asset:nb-import-1)\n\n![c](asset:nb-import-2)',
        [
          { id: '0', data: RED },
          { id: '1', data: RED },
          { id: '2', data: BLUE },
        ],
      ),
    );
    expect(result.storedIds).toHaveLength(2);
    const ids = [...result.markdown.matchAll(/asset:([^)]+)/g)].map((m) => m[1]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('stores the bytes it was given, under their own content hash', async () => {
    const result = await materialiseAssets(
      document('![Fig](asset:nb-import-0)', [{ id: '0', data: RED }]),
    );
    const blob = await assets.get(result.storedIds[0] as string);
    expect(blob?.size).toBe('red-bytes'.length);
    expect(blob?.type).toBe('image/png');
  });

  /**
   * A placeholder with no asset behind it would become a dead id, which the
   * editor renders as a broken image. The caption is what the line still
   * honestly has.
   */
  it('degrades an unbacked image to its caption and says so', async () => {
    // Rust renders the placeholder, then refuses the bytes for breaking the
    // byte ceiling — so a document with no assets can still carry references.
    const result = await materialiseAssets(
      document('before\n\n![Missing figure](asset:nb-import-7)\n\nafter', []),
    );
    expect(result.markdown).toBe('before\n\nMissing figure\n\nafter');
    expect(result.warnings).toContainEqual({ code: 'assetDropped', count: 1 });
  });

  it('reports an image whose bytes will not decode', async () => {
    const result = await materialiseAssets(
      document('![Fig](asset:nb-import-0)', [{ id: '0', data: '!!!not base64!!!' }]),
    );
    expect(result.warnings).toContainEqual({ code: 'assetStoreFailed', count: 1 });
    expect(result.markdown).toBe('Fig');
  });

  it('leaves a document with no images exactly as it found it', async () => {
    const markdown = '# Notes\n\nNothing embedded here.';
    const result = await materialiseAssets(document(markdown, []));
    expect(result).toEqual({ markdown, storedIds: [], warnings: [] });
  });
});
