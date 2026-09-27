/// <reference lib="webworker" />

import { unzipSync, zipSync } from 'fflate';

type Request =
  | { kind: 'zip'; entries: [string, ArrayBuffer][]; level: CompressionLevel }
  | { kind: 'unzip'; archive: ArrayBuffer; maxBytes?: number };

type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Refuse an archive whose entries declare more than `maxBytes` in total.
 *
 * fflate sizes each output buffer from the entry's declared size, so the
 * declaration is what bounds memory — a zip bomb has to declare its payload
 * to inflate it, and this is where that declaration is read.
 */
function declaredSizeGuard(maxBytes: number | undefined) {
  let total = 0;
  return (file: { originalSize: number }): boolean => {
    if (maxBytes === undefined) return true;
    total += file.originalSize;
    if (total > maxBytes) throw new Error('too_large:archive expands past its limit');
    return true;
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

self.addEventListener('message', (event: MessageEvent<Request>) => {
  try {
    if (event.data.kind === 'zip') {
      const files = Object.fromEntries(
        event.data.entries.map(([path, bytes]) => [path, new Uint8Array(bytes)]),
      );
      const archive = zipSync(files, { level: event.data.level });
      const buffer = archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ) as ArrayBuffer;
      self.postMessage({ ok: true, kind: 'zip', archive: buffer }, [buffer]);
      return;
    }

    const files = unzipSync(new Uint8Array(event.data.archive), {
      filter: declaredSizeGuard(event.data.maxBytes),
    });
    const entries = Object.entries(files).map(([path, bytes]) => {
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return [path, buffer] as [string, ArrayBuffer];
    });
    self.postMessage(
      { ok: true, kind: 'unzip', entries },
      entries.map(([, buffer]) => buffer),
    );
  } catch (cause) {
    self.postMessage({ ok: false, error: errorMessage(cause) });
  }
});

export {};
