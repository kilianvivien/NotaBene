/// <reference lib="webworker" />

import { createEncoder } from 'wasm-media-encoders';
import { parseWav } from './wav';

self.addEventListener(
  'message',
  async (event: MessageEvent<{ wav: ArrayBuffer; wasmUrl: string }>) => {
    try {
      const joined = parseWav(new Uint8Array(event.data.wav));
      if (joined.format.bitsPerSample !== 16) {
        throw new Error('MP3 export requires 16-bit PCM audio');
      }
      if (joined.format.channels !== 1 && joined.format.channels !== 2) {
        throw new Error('MP3 export requires mono or stereo audio');
      }

      const encoder = await createEncoder('audio/mpeg', event.data.wasmUrl);
      encoder.configure({
        sampleRate: joined.format.sampleRate,
        channels: joined.format.channels,
        bitrate: 96,
      });
      const view = new DataView(
        joined.samples.buffer,
        joined.samples.byteOffset,
        joined.samples.byteLength,
      );
      const frames = joined.samples.byteLength / (2 * joined.format.channels);
      const chunks: Uint8Array[] = [];
      const frameChunk = 1152 * 16;
      for (let start = 0; start < frames; start += frameChunk) {
        const count = Math.min(frameChunk, frames - start);
        const channels = Array.from(
          { length: joined.format.channels },
          () => new Float32Array(count),
        );
        for (let frame = 0; frame < count; frame += 1) {
          for (let channel = 0; channel < channels.length; channel += 1) {
            channels[channel]![frame] =
              view.getInt16(((start + frame) * channels.length + channel) * 2, true) /
              32768;
          }
        }
        const encoded = encoder.encode(channels);
        if (encoded.length) chunks.push(encoded.slice());
      }
      const final = encoder.finalize();
      if (final.length) chunks.push(final.slice());
      const combined = new Uint8Array(
        chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      self.postMessage({ ok: true, bytes: combined.buffer }, [combined.buffer]);
    } catch (cause) {
      self.postMessage({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  },
);

export {};
