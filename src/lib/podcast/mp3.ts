export async function encodeMp3OffThread(
  wav: Uint8Array,
  wasmUrl: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = wav.slice().buffer;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener(
      'message',
      (
        event: MessageEvent<
          { ok: true; bytes: ArrayBuffer } | { ok: false; error: string }
        >,
      ) => {
        worker.terminate();
        if (event.data.ok) resolve(new Uint8Array(event.data.bytes));
        else reject(new Error(event.data.error));
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
    worker.postMessage({ wav: buffer, wasmUrl }, [buffer]);
  });
}
