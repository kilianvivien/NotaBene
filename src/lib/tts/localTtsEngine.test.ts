import { describe, expect, it } from 'vitest';
import { decodeNativeWav } from '@/lib/adapters/tts/wav';
import { encodeWav } from '@/lib/podcast/wav';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('native TTS WAV boundary', () => {
  it('accepts the exact local model format', async () => {
    const wav = encodeWav({
      format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
      samples: new Uint8Array(480),
    });
    const result = decodeNativeWav(
      { data: base64(wav), mime: 'audio/wav', durationMs: 10 },
      { sampleRateHz: 24_000, channels: 1, bitsPerSample: 16 },
    );
    expect(result).toMatchObject({
      durationMs: 10,
      sampleRateHz: 24_000,
      channels: 1,
    });
    expect(result.audio.size).toBe(wav.length);
  });

  it('rejects invalid bytes and unexpected sample rates', () => {
    expect(() =>
      decodeNativeWav({ data: btoa('not audio'), mime: 'audio/wav', durationMs: 1 }),
    ).toThrow(/TTS_AUDIO_INVALID/);

    const wav = encodeWav({
      format: { sampleRate: 22_050, channels: 1, bitsPerSample: 16 },
      samples: new Uint8Array(442),
    });
    expect(() =>
      decodeNativeWav(
        { data: base64(wav), mime: 'audio/wav', durationMs: 10 },
        { sampleRateHz: 24_000, channels: 1, bitsPerSample: 16 },
      ),
    ).toThrow(/does not match/);
  });
});
