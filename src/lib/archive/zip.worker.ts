/// <reference lib="webworker" />

import { unzipSync, zipSync } from 'fflate';

type Request =
  | { kind: 'zip'; entries: [string, ArrayBuffer][]; level: CompressionLevel }
  | { kind: 'unzip'; archive: ArrayBuffer };

type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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

    const files = unzipSync(new Uint8Array(event.data.archive));
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
