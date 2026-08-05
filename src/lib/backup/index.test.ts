/**
 * The archive envelope itself: what it promises about its own contents, and
 * what it does when the library it is being asked to describe is not whole.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assets } from '@/lib/adapters';
import { createNote, emptyLibrary } from '@/lib/schema';
import { createBackupArchive, parseBackupArchive } from './index';

/** jsdom's `Blob` has no `arrayBuffer()`, which is the same reason
 * `blobBytes` in the module under test carries a `FileReader` fallback. */
function bytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      'load',
      () => resolve(new Uint8Array(reader.result as ArrayBuffer)),
      { once: true },
    );
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

/** Unzip an archive, run `edit` over its files, and zip the result back up —
 * the shape of the tampering the digest exists to catch. */
async function rewrite(
  archive: Blob,
  edit: (files: Record<string, Uint8Array>) => void,
): Promise<Blob> {
  const files = unzipSync(await bytes(archive));
  edit(files);
  return new Blob([zipSync(files)]);
}

// The memory asset store is content-addressed, so writing the same bytes twice
// is idempotent and there is nothing to reset between tests.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('backup archives', () => {
  it('hashes library.json, and rejects an archive whose library was edited', async () => {
    const library = emptyLibrary();
    library.notes.push(createNote({ id: 'note', title: 'Original' }));
    const { blob } = await createBackupArchive(library);

    const manifest = JSON.parse(
      strFromU8(unzipSync(await bytes(blob))['manifest.json']!),
    );
    expect(manifest.librarySha256).toMatch(/^[0-9a-f]{64}$/);

    const tampered = await rewrite(blob, (files) => {
      const edited = JSON.parse(strFromU8(files['library.json']!));
      edited.notes[0].title = 'Rewritten';
      files['library.json'] = strToU8(JSON.stringify(edited, null, 2));
    });

    // Still valid JSON, still passes the schema — the digest is the only thing
    // standing between a corrupted library and a silent restore.
    await expect(parseBackupArchive(tampered)).rejects.toThrow(/integrity/i);
  });

  it('still reads an archive written before the digest existed', async () => {
    const library = emptyLibrary();
    library.notes.push(createNote({ id: 'note', title: 'Older backup' }));
    const { blob } = await createBackupArchive(library);

    const older = await rewrite(blob, (files) => {
      const manifest = JSON.parse(strFromU8(files['manifest.json']!));
      delete manifest.librarySha256;
      delete manifest.missingAssets;
      files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
    });

    const parsed = await parseBackupArchive(older);
    expect(parsed.library.notes[0]?.title).toBe('Older backup');
    expect(parsed.manifest.missingAssets).toEqual([]);
  });

  it('backs up what it can when an attachment is missing from disk', async () => {
    const library = emptyLibrary();
    const present = await assets.put(new Blob(['here'], { type: 'image/png' }));
    library.assets.push(present);
    library.assets.push({
      ...present,
      // A row whose blob was deleted out from under the library. One of these
      // used to make every future backup throw.
      id: 'a'.repeat(64),
    });

    const { blob, missingAssets } = await createBackupArchive(library);

    expect(missingAssets).toEqual(['a'.repeat(64)]);
    const parsed = await parseBackupArchive(blob);
    expect(parsed.manifest.missingAssets).toEqual(['a'.repeat(64)]);
    expect(parsed.assetBlobs.has(present.id)).toBe(true);
    expect(parsed.manifest.counts.assets).toBe(2);
  });

  it('does not let an unreadable asset store abort the backup', async () => {
    const library = emptyLibrary();
    const asset = await assets.put(new Blob(['here'], { type: 'image/png' }));
    library.assets.push(asset);
    vi.spyOn(assets, 'get').mockRejectedValue(new Error('disk went away'));

    const { blob, missingAssets } = await createBackupArchive(library);

    expect(missingAssets).toEqual([asset.id]);
    await expect(parseBackupArchive(blob)).resolves.toBeTruthy();
  });

  it('still rejects an asset whose bytes do not match its content address', async () => {
    const library = emptyLibrary();
    const asset = await assets.put(new Blob(['here'], { type: 'image/png' }));
    library.assets.push(asset);
    const { blob } = await createBackupArchive(library);

    const swapped = await rewrite(blob, (files) => {
      const manifest = JSON.parse(strFromU8(files['manifest.json']!));
      const path: string = manifest.assets[0].path;
      files[path] = strToU8('different bytes entirely');
    });

    await expect(parseBackupArchive(swapped)).rejects.toThrow(/integrity/i);
  });
});
