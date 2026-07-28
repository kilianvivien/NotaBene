import { describe, expect, it } from 'vitest';
import type { AiRequest, AiResponse, AiTransport } from '@/lib/adapters/ai/AiTransport';
import type { SecretsAdapter } from '@/lib/adapters/settings/SettingsAdapter';
import { createGeminiTtsEngine } from '@/lib/adapters/tts/geminiTtsEngine';

function fakeSecrets(key: string | null): SecretsAdapter {
  return {
    async get() {
      return key;
    },
    async set() {},
    async remove() {},
    async listKeys() {
      return key ? ['ai.gemini.apiKey'] : [];
    },
  };
}

function fakeTransport(
  handler: (request: AiRequest, call: number) => AiResponse,
): AiTransport {
  let calls = 0;
  return {
    async request(request) {
      calls += 1;
      return handler(request, calls);
    },
    async *stream() {
      yield* [];
      throw new Error('unused');
    },
  };
}

describe('Gemini hosted TTS engine', () => {
  it('uses the existing Gemini provider key and exposes the documented voices', async () => {
    const transport = fakeTransport(() => ({ status: 200, headers: {}, body: '{}' }));
    await expect(
      createGeminiTtsEngine(transport, fakeSecrets(null)).status(),
    ).resolves.toEqual({ kind: 'not_configured' });

    const engine = createGeminiTtsEngine(transport, fakeSecrets('secret'));
    await expect(engine.status()).resolves.toEqual({ kind: 'ready' });
    const voices = await engine.listVoices();
    expect(voices).toHaveLength(30);
    expect(voices).toContainEqual({
      id: 'Kore',
      name: 'Kore · Firm',
      locale: 'mul',
      quality: 'premium',
    });
  });

  it('requests raw PCM from the pinned model and wraps it in a WAV', async () => {
    const pcm = new Uint8Array(48_000);
    const engine = createGeminiTtsEngine(
      fakeTransport((request) => {
        expect(request.url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent',
        );
        expect(request.headers['x-goog-api-key']).toBe('secret');
        const body = JSON.parse(request.body ?? '');
        expect(body.generationConfig).toEqual({
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        });
        expect(body.contents[0].parts[0].text).toContain('Transcript:\nBonjour.');
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                        data: Buffer.from(pcm).toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }),
      fakeSecrets('secret'),
    );

    const result = await engine.synthesize({ text: 'Bonjour.', voiceId: 'Kore' });
    expect(result.audio.type).toBe('audio/wav');
    expect(result.durationMs).toBe(1000);
    expect(result.sampleRateHz).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(result.audio.size).toBe(48_044);
  });

  it('retries the preview model once after its documented transient 500', async () => {
    const pcm = new Uint8Array(2);
    const engine = createGeminiTtsEngine(
      fakeTransport((_request, call) =>
        call === 1
          ? { status: 500, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: {},
              body: JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        { inlineData: { data: Buffer.from(pcm).toString('base64') } },
                      ],
                    },
                  },
                ],
              }),
            },
      ),
      fakeSecrets('secret'),
    );

    await expect(
      engine.synthesize({ text: 'Hello.', voiceId: 'Kore' }),
    ).resolves.toMatchObject({ sampleRateHz: 24_000 });
  });

  it('rejects malformed audio before playback', async () => {
    const engine = createGeminiTtsEngine(
      fakeTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: Buffer.from([0]).toString('base64') } }],
              },
            },
          ],
        }),
      })),
      fakeSecrets('secret'),
    );

    await expect(engine.synthesize({ text: 'Hello.', voiceId: 'Kore' })).rejects.toThrow(
      /TTS_AUDIO_INVALID/,
    );
  });
});
