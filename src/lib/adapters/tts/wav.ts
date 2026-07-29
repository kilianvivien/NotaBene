import type { TtsSegmentResult } from './TtsEngine';

interface NativeWavSegment {
  data: string;
  mime: string;
  durationMs: number;
  sampleRateHz?: number;
  channels?: number;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Validate the native boundary instead of trusting MIME metadata alone. */
export function decodeNativeWav(
  segment: NativeWavSegment,
  expected?: { sampleRateHz: number; channels: 1 | 2; bitsPerSample: number },
): TtsSegmentResult {
  if (segment.mime !== 'audio/wav') {
    throw new Error('TTS_AUDIO_INVALID: The speech engine returned an unexpected format.');
  }
  const bytes = decodeBase64(segment.data);
  if (
    bytes.length < 44 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' ||
    new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WAVE'
  ) {
    throw new Error('TTS_AUDIO_INVALID: The speech engine returned an invalid WAV file.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: { channels: 1 | 2; sampleRateHz: number; bitsPerSample: number } | null =
    null;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) {
      throw new Error('TTS_AUDIO_INVALID: The WAV file is truncated.');
    }
    if (id === 'fmt ' && size >= 16) {
      const encoding = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      if (encoding !== 1 || (channels !== 1 && channels !== 2)) {
        throw new Error('TTS_AUDIO_INVALID: Only mono or stereo PCM WAV is supported.');
      }
      format = {
        channels,
        sampleRateHz: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    }
    if (id === 'data') dataBytes = size;
    offset = body + size + (size % 2);
  }
  if (!format || !dataBytes || format.bitsPerSample !== 16) {
    throw new Error('TTS_AUDIO_INVALID: The WAV file has no 16-bit PCM audio.');
  }
  if (
    expected &&
    (format.sampleRateHz !== expected.sampleRateHz ||
      format.channels !== expected.channels ||
      format.bitsPerSample !== expected.bitsPerSample)
  ) {
    throw new Error(
      'TTS_AUDIO_INVALID: The WAV format does not match the speech engine.',
    );
  }
  const calculatedDuration =
    (dataBytes / (format.sampleRateHz * format.channels * (format.bitsPerSample / 8))) *
    1000;
  if (
    !Number.isFinite(segment.durationMs) ||
    segment.durationMs <= 0 ||
    Math.abs(segment.durationMs - calculatedDuration) > 100
  ) {
    throw new Error('TTS_AUDIO_INVALID: The WAV duration metadata is inconsistent.');
  }

  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  return {
    audio: new Blob([blobBytes.buffer], { type: 'audio/wav' }),
    durationMs: segment.durationMs,
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
  };
}
