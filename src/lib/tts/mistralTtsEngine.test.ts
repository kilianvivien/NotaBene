import { describe, expect, it } from 'vitest';
import type { AiRequest, AiResponse, AiTransport } from '@/lib/adapters/ai/AiTransport';
import type { SecretsAdapter } from '@/lib/adapters/settings/SettingsAdapter';
import { createMistralTtsEngine } from '@/lib/adapters/tts/mistralTtsEngine';
import { encodeWav } from '@/lib/podcast/wav';

function fakeSecrets(key: string | null): SecretsAdapter {
  return {
    async get() {
      return key;
    },
    async set() {},
    async remove() {},
    async listKeys() {
      return key ? ['ai.mistral.apiKey'] : [];
    },
  };
}

function fakeTransport(handler: (request: AiRequest) => AiResponse): AiTransport {
  return {
    async request(request) {
      return handler(request);
    },
    async *stream() {
      yield* [];
      throw new Error('unused');
    },
  };
}

describe('Mistral hosted Voxtral engine', () => {
  it('is available only when the Mistral key is configured', async () => {
    const transport = fakeTransport(() => ({ status: 200, headers: {}, body: '{}' }));
    await expect(
      createMistralTtsEngine(transport, fakeSecrets(null)).status(),
    ).resolves.toEqual({ kind: 'not_configured' });
    await expect(
      createMistralTtsEngine(transport, fakeSecrets('secret')).status(),
    ).resolves.toEqual({ kind: 'ready' });
  });

  it('lists preset and custom voices through the authenticated voices endpoint', async () => {
    const engine = createMistralTtsEngine(
      fakeTransport((request) => {
        expect(request.url).toBe(
          'https://api.mistral.ai/v1/audio/voices?limit=1000&type=all',
        );
        expect(request.headers.Authorization).toBe('Bearer secret');
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            items: [
              { id: 'voice-1', name: 'Narrator', languages: ['fr'] },
              { id: 'voice-2', name: 'Multilingual', languages: [] },
            ],
          }),
        };
      }),
      fakeSecrets('secret'),
    );

    await expect(engine.listVoices()).resolves.toEqual([
      {
        id: 'voice-1',
        name: 'Narrator',
        locale: 'fr',
        quality: 'premium',
      },
      {
        id: 'voice-2',
        name: 'Multilingual',
        locale: 'mul',
        quality: 'premium',
      },
    ]);
  });

  it('requests and validates a complete WAV from the pinned hosted model', async () => {
    const wav = encodeWav({
      format: { sampleRate: 24_000, channels: 1, bitsPerSample: 16 },
      samples: new Uint8Array(48_000),
    });
    const engine = createMistralTtsEngine(
      fakeTransport((request) => {
        expect(request.url).toBe('https://api.mistral.ai/v1/audio/speech');
        expect(JSON.parse(request.body ?? '')).toEqual({
          model: 'voxtral-mini-tts-2603',
          input: 'Bonjour.',
          voice_id: 'voice-1',
          response_format: 'wav',
          stream: false,
        });
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            audio_data: Buffer.from(wav).toString('base64'),
          }),
        };
      }),
      fakeSecrets('secret'),
    );

    const result = await engine.synthesize({
      text: 'Bonjour.',
      voiceId: 'voice-1',
    });
    expect(result.audio.type).toBe('audio/wav');
    expect(result.durationMs).toBe(1000);
    expect(result.sampleRateHz).toBe(24_000);
    expect(result.channels).toBe(1);
  });

  it('rejects malformed provider payloads before playback', async () => {
    const engine = createMistralTtsEngine(
      fakeTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ audio_data: 'not valid base64 %%%' }),
      })),
      fakeSecrets('secret'),
    );
    await expect(
      engine.synthesize({ text: 'Hello.', voiceId: 'voice-1' }),
    ).rejects.toThrow(/TTS_AUDIO_INVALID/);
  });
});
