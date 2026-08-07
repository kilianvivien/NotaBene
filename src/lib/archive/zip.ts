import { unzipSync, zipSync } from 'fflate';

type WorkerRequest =
  | { kind: 'zip'; entries: [string, ArrayBuffer][]; level: CompressionLevel }
  | { kind: 'unzip'; archive: ArrayBuffer };

type WorkerResponse =
  | { ok: true; kind: 'zip'; archive: ArrayBuffer }
  | { ok: true; kind: 'unzip'; entries: [string, ArrayBuffer][] }
  | { ok: false; error: string };

type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function workerAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

function runWorker(
  request: WorkerRequest,
  transfer: Transferable[],
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zip.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
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

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/** Compress off the render thread when Workers are available. */
export async function zipFiles(
  files: Record<string, Uint8Array>,
  level: CompressionLevel = 6,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!workerAvailable()) return zipSync(files, { level });

  const entries = Object.entries(files).map(
    ([path, bytes]) => [path, ownedBuffer(bytes)] as [string, ArrayBuffer],
  );
  const result = await runWorker(
    { kind: 'zip', entries, level },
    entries.map(([, buffer]) => buffer),
  );
  if (!result.ok) throw new Error(result.error);
  if (result.kind !== 'zip') throw new Error('archive worker returned the wrong result');
  return new Uint8Array(result.archive);
}

/** Decompress off the render thread when Workers are available. */
export async function unzipFiles(
  archive: Uint8Array,
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  if (!workerAvailable())
    return unzipSync(archive) as Record<string, Uint8Array<ArrayBuffer>>;

  const buffer = ownedBuffer(archive);
  const result = await runWorker({ kind: 'unzip', archive: buffer }, [buffer]);
  if (!result.ok) throw new Error(result.error);
  if (result.kind !== 'unzip')
    throw new Error('archive worker returned the wrong result');
  return Object.fromEntries(
    result.entries.map(([path, bytes]) => [path, new Uint8Array(bytes)]),
  );
}
