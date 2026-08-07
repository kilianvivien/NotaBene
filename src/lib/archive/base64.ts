type Request =
  { kind: 'encode'; bytes: ArrayBuffer } | { kind: 'decode'; base64: string };

type Response =
  | { ok: true; kind: 'encode'; base64: string }
  | { ok: true; kind: 'decode'; bytes: ArrayBuffer }
  | { ok: false; error: string };

function encodeSync(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeSync(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function runWorker(request: Request, transfer: Transferable[] = []): Promise<Response> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./base64.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener(
      'message',
      (event: MessageEvent<Response>) => {
        worker.terminate();
        resolve(event.data);
      },
      { once: true },
    );
    worker.addEventListener(
      'error',
      (event) => {
        worker.terminate();
        reject(event.error ?? new Error(event.message));
      },
      { once: true },
    );
    worker.postMessage(request, transfer);
  });
}

export async function encodeBlobBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (typeof Worker === 'undefined') return encodeSync(new Uint8Array(buffer));
  const result = await runWorker({ kind: 'encode', bytes: buffer }, [buffer]);
  if (!result.ok) throw new Error(result.error);
  if (result.kind !== 'encode')
    throw new Error('base64 worker returned the wrong result');
  return result.base64;
}

export async function decodeBase64(base64: string): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Worker === 'undefined') return decodeSync(base64);
  const result = await runWorker({ kind: 'decode', base64 });
  if (!result.ok) throw new Error(result.error);
  if (result.kind !== 'decode')
    throw new Error('base64 worker returned the wrong result');
  return new Uint8Array(result.bytes);
}
