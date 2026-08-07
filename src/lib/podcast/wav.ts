/**
 * WAV, just enough of it.
 *
 * The TTS engine hands back one file per script segment, because the player
 * seeks between segments and because a synthesiser that produced one twelve-
 * minute blob would give the student nothing until it had finished all of it.
 * Saving the episode, though, has to produce a single file — nobody wants
 * ninety `.wav`s in their Downloads folder.
 *
 * Concatenating PCM is the one audio operation that is genuinely trivial, and
 * it is trivial only because every segment comes from the same engine at the
 * same settings: identical sample rate, channel count and bit depth. That
 * assumption is checked rather than assumed, because a mismatch would not fail
 * — it would produce an episode that plays back at the wrong speed.
 */
export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface WavAudio {
  format: WavFormat;
  /** Raw PCM frames, without any header. */
  samples: Uint8Array;
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Read a RIFF/WAVE file.
 *
 * Walks the chunk list rather than assuming `fmt ` at 12 and `data` at 36:
 * macOS writes a `LIST`/`INFO` chunk into what `say` produces, and a reader
 * that trusted the canonical offsets would take that metadata for audio.
 */
export function parseWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourCc(view, 0) !== 'RIFF' || fourCc(view, 8) !== 'WAVE') {
    throw new Error('not a WAV file');
  }

  let format: WavFormat | null = null;
  let samples: Uint8Array | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const id = fourCc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength && id !== 'data') break;

    if (id === 'fmt ' && size >= 16) {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // A `data` size larger than the file means the writer streamed and never
      // went back to patch the header. Taking what is actually there loses
      // nothing and is what every player does.
      const end = Math.min(body + size, bytes.byteLength);
      samples = bytes.subarray(body, end);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte that is
    // not counted in it.
    offset = body + size + (size % 2);
  }

  if (!format || !samples) throw new Error('WAV file has no format or no audio');
  if (!format.sampleRate || !format.channels || !format.bitsPerSample) {
    throw new Error('WAV file declares an unusable format');
  }
  return { format, samples };
}

export function wavDurationMs(audio: WavAudio): number {
  const bytesPerFrame = (audio.format.bitsPerSample / 8) * audio.format.channels;
  if (!bytesPerFrame) return 0;
  return Math.round(
    (audio.samples.byteLength / bytesPerFrame / audio.format.sampleRate) * 1000,
  );
}

function sameFormat(a: WavFormat, b: WavFormat): boolean {
  return (
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels &&
    a.bitsPerSample === b.bitsPerSample
  );
}

/** Wrap raw PCM in a canonical 44-byte header. The return type is pinned to a
 * plain `ArrayBuffer` so the result can go straight into a `Blob`; a
 * `SharedArrayBuffer`-backed view is not a `BlobPart`. */
export function encodeWav(audio: WavAudio): Uint8Array<ArrayBuffer> {
  const { sampleRate, channels, bitsPerSample } = audio.format;
  const blockAlign = (bitsPerSample / 8) * channels;
  const out = new Uint8Array(44 + audio.samples.byteLength);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + audio.samples.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, audio.samples.byteLength, true);
  out.set(audio.samples, 44);
  return out;
}

/**
 * Join segments into one file, with a short silence between them.
 *
 * The gap is not decoration. Segments are separate synthesiser runs, so each
 * one starts the instant the last ended; without a pause the episode runs its
 * sentences together and sounds like a machine reading a list, which is exactly
 * what it is trying not to sound like.
 *
 * Returns bytes rather than a `Blob`: this module is about the format, and the
 * caller is the one that knows whether the result is being written, played, or
 * handed to the export sink.
 */
export function concatWav(files: Uint8Array[], gapMs = 350): Uint8Array<ArrayBuffer> {
  if (!files.length) throw new Error('nothing to join');

  const parsed = files.map(parseWav);
  const format = parsed[0]!.format;
  for (const audio of parsed) {
    if (!sameFormat(audio.format, format)) {
      throw new Error('audio segments do not share one format');
    }
  }

  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  const gapFrames = Math.round((gapMs / 1000) * format.sampleRate);
  // Signed PCM: silence is zero. 8-bit WAV is the exception — it is unsigned,
  // with 128 as the midpoint — and `say` never writes it, but filling with the
  // right value costs one line and removes the footgun.
  const gap = new Uint8Array(gapFrames * bytesPerFrame).fill(
    format.bitsPerSample === 8 ? 128 : 0,
  );

  const total = parsed.reduce(
    (sum, audio, index) => sum + audio.samples.byteLength + (index ? gap.byteLength : 0),
    0,
  );

  const samples = new Uint8Array(total);
  let cursor = 0;
  for (const [index, audio] of parsed.entries()) {
    if (index) {
      samples.set(gap, cursor);
      cursor += gap.byteLength;
    }
    samples.set(audio.samples, cursor);
    cursor += audio.samples.byteLength;
  }

  return encodeWav({ format, samples });
}

/** Join large episodes away from the editor's render thread. */
export async function concatWavOffThread(
  files: Uint8Array[],
  gapMs = 350,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Worker === 'undefined') return concatWav(files, gapMs);

  const buffers = files.map((file) => file.slice().buffer);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./wav.worker.ts', import.meta.url), {
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
    worker.postMessage({ files: buffers, gapMs }, buffers);
  });
}
