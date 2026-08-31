import { storeAssetCommand } from '@/lib/commands/assetCommands';
import { decodeBase64 } from '@/lib/archive/base64';
import type { ImportedDocument, ImportWarning } from '@/lib/schema';

/**
 * Turn an imported document's embedded images into stored assets, and point
 * its Markdown at them.
 *
 * The Rust renderer cannot name an asset the way a note does, because a
 * NotaBene asset is identified by the SHA-256 of its bytes and nothing has
 * hashed them yet. So it writes `![alt](asset:nb-import-3)` — the index into
 * `document.assets` — and this pairs the two up after `assets.put` has
 * hashed and stored each one.
 *
 * `assets.put` is content-addressed and idempotent, so a logo repeated on
 * forty slides is stored once and every placeholder resolves to the same id.
 *
 * Writes assets and nothing else: no note, no attachment. The caller decides
 * whether a note is created at all, which is what lets the import dialog show
 * a preview with real images before anything is committed.
 */
export interface MaterialisedAssets {
  markdown: string;
  /** Asset ids stored, deduplicated — the same image twice is one id. */
  storedIds: string[];
  /** Appended to the document's own warnings, in the same shape. */
  warnings: ImportWarning[];
}

/** Written by `render.rs`; `ASSET_PLACEHOLDER` there is the other half. */
const PLACEHOLDER = /\(asset:nb-import-(\d+)\)/g;

export async function materialiseAssets(
  document: ImportedDocument,
): Promise<MaterialisedAssets> {
  // No early return on an empty asset list: Rust drops an image that breaks
  // the byte ceiling but still rendered its placeholder, so a document with
  // no assets can very much still have references to clean up.
  const resolved = new Map<string, string>();
  let failed = 0;

  for (const asset of document.assets) {
    try {
      const bytes = await decodeBase64(asset.data);
      const stored = await storeAssetCommand(
        new Blob([bytes], { type: asset.mime || 'application/octet-stream' }),
      );
      if (!stored.ok) {
        failed += 1;
        continue;
      }
      resolved.set(asset.id, stored.value.id);
    } catch {
      // One unreadable image must not cost the document its text.
      failed += 1;
    }
  }

  let unresolved = 0;
  const markdown = document.markdown.replace(PLACEHOLDER, (_match, id: string) => {
    const stored = resolved.get(id);
    if (stored) return `(asset:${stored})`;
    // The image did not survive. Leaving the placeholder would put a dead
    // asset id in the note, which renders as a broken image, so the line
    // degrades to its caption — ordinary text.
    unresolved += 1;
    return '()';
  });

  const warnings: ImportWarning[] = [];
  if (failed) warnings.push({ code: 'assetStoreFailed', count: failed });
  if (unresolved) warnings.push({ code: 'assetDropped', count: unresolved });

  return {
    markdown: stripDeadImages(markdown),
    storedIds: [...new Set(resolved.values())],
    warnings,
  };
}

/** `![caption]()` is not an image; reduce it to the caption it still has. */
function stripDeadImages(markdown: string): string {
  return markdown.replace(/^!\[([^\]]*)\]\(\)[ \t]*$/gm, '$1');
}
