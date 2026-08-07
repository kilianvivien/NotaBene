/// <reference lib="webworker" />

type Request =
  { kind: 'encode'; bytes: ArrayBuffer } | { kind: 'decode'; base64: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

self.addEventListener('message', (event: MessageEvent<Request>) => {
  try {
    if (event.data.kind === 'encode') {
      const bytes = new Uint8Array(event.data.bytes);
      let binary = '';
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      self.postMessage({ ok: true, kind: 'encode', base64: btoa(binary) });
      return;
    }

    const binary = atob(event.data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    self.postMessage({ ok: true, kind: 'decode', bytes: bytes.buffer }, [bytes.buffer]);
  } catch (cause) {
    self.postMessage({ ok: false, error: errorMessage(cause) });
  }
});

export {};
