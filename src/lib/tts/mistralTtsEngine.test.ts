import { describe, expect, it } from 'vitest';
import type { AiRequest, AiResponse, AiTransport } from '@/lib/adapters/ai/AiTransport';
import type { SecretsAdapter } from '@/lib/adapters/settings/SettingsAdapter';
import { createMistralTtsEngine } from '@/lib/adapters/tts/mistralTtsEngine';
import { encodeWav } from '@/lib/podcast/wav';

function fakeSecrets(key: string | null): SecretsAdapter {
  return {
    async get(name) {
      return name === 'ai.mistral.apiKey' ? key : null;
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
          'https://api.mistral.ai/v2/audio/voices?page_size=100&type=all',
        );
        expect(request.headers.Authorization).toBe('Bearer secret');
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [
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
          model: 'voxtral-mini-tts-3-0',
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

  it('follows voice cursors and keeps both new presets and saved voices', async () => {
    const urls: string[] = [];
    const engine = createMistralTtsEngine(
      fakeTransport((request) => {
        urls.push(request.url);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            urls.length === 1
              ? {
                  data: [{ id: 'voice_478', name: 'Sarah', languages: ['en'] }],
                  next_page_token: 'cursor+/=',
                }
              : {
                  data: [{ id: 'saved-voice', name: 'My voice' }],
                  next_page_token: null,
                },
          ),
        };
      }),
      fakeSecrets('secret'),
    );
    await expect(engine.listVoices()).resolves.toEqual([
      { id: 'voice_478', name: 'Sarah', locale: 'en', quality: 'premium' },
      { id: 'saved-voice', name: 'My voice', locale: 'mul', quality: 'premium' },
    ]);
    expect(urls).toEqual([
      'https://api.mistral.ai/v2/audio/voices?page_size=100&type=all',
      'https://api.mistral.ai/v2/audio/voices?page_size=100&type=all&page_token=cursor%2B%2F%3D',
    ]);
  });

  it('refuses a repeated voice cursor instead of looping', async () => {
    const engine = createMistralTtsEngine(
      fakeTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ data: [], next_page_token: 'same-page' }),
      })),
      fakeSecrets('secret'),
    );
    await expect(engine.listVoices()).rejects.toThrow(/TTS_API_INVALID_RESPONSE/);
  });

  it('reports a Voxtral 3 API failure without trying an older model', async () => {
    let calls = 0;
    const engine = createMistralTtsEngine(
      fakeTransport(() => {
        calls += 1;
        return { status: 403, headers: {}, body: '{"message":"Model unavailable"}' };
      }),
      fakeSecrets('secret'),
    );
    await expect(
      engine.synthesize({ text: 'Hello.', voiceId: 'voice_478' }),
    ).rejects.toThrow('TTS_API_ERROR: 403 Model unavailable');
    expect(calls).toBe(1);
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
