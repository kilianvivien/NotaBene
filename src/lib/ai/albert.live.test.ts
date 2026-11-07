// @vitest-environment node
/** Opt-in live checks, using synthetic content and a private key file.
 * NOTABENE_ALBERT_SMOKE_KEY_FILE=/private/key pnpm test -- src/lib/ai/albert.live.test.ts
 * Optional NOTABENE_ALBERT_SMOKE_AUDIO_FILE: a short synthetic 16 kHz mono WAV.
 * No key, response body, or user library content is printed or persisted. */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAlbertAsrEngine } from '@/lib/adapters/asr/albertAsrEngine';
import { fetchAiTransport } from '@/lib/adapters/ai/fetchAiTransport';
import type { AiTransport } from '@/lib/adapters/ai/AiTransport';
import { buildRequest, parseToolResponse, type ResolvedProvider } from './protocols';
import { providerById } from './providers';
import { runAi } from './client';
import { runStructured } from './structured';

const keyFile = process.env.NOTABENE_ALBERT_SMOKE_KEY_FILE;
const audioFile = process.env.NOTABENE_ALBERT_SMOKE_AUDIO_FILE;

function provider(model = 'openweight-medium'): ResolvedProvider {
  if (!keyFile) throw new Error('A private Albert key file is required');
  return {
    definition: providerById('albert')!,
    baseUrl: 'https://albert.api.etalab.gouv.fr/v1',
    apiKey: readFileSync(keyFile, 'utf8').trim(),
    model,
  };
}

// A solid red PNG built in memory. No image from the student's library.
function redImage(): string {
  const crc = (data: Buffer) => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

describe.skipIf(!keyFile)('live Albert API', () => {
  it('streams a text answer through the shared AI client', async () => {
    let streamed = '';
    const text = await runAi(
      {
        provider: provider(),
        messages: [{ role: 'user', content: 'Reply with only the word Bonjour.' }],
        maxTokens: 8192,
        temperature: 0.1,
        json: false,
        stream: true,
      },
      {
        onToken: (token) => {
          streamed += token;
        },
      },
    );
    expect(text).toMatch(/Bonjour/i);
    expect(streamed).toBe(text);
  }, 180_000);

  it('returns validated JSON through the structured feature client', async () => {
    const response = await runStructured(
      {
        provider: provider(),
        messages: [
          {
            role: 'user',
            content: 'Return a JSON object with value equal to albert-ok.',
          },
        ],
        maxTokens: 8192,
        temperature: 0,
        jsonSchema: {
          name: 'answer',
          schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
      z.object({ value: z.literal('albert-ok') }),
    );
    expect(response.value).toBe('albert-ok');
  }, 180_000);

  it('returns native agent tool calls on the default agent model', async () => {
    const resolved = provider('openweight-large');
    const request = buildRequest({
      provider: resolved,
      messages: [
        { role: 'user', content: 'Call finish with result equal to albert-ok.' },
      ],
      maxTokens: 8192,
      temperature: 0.1,
      json: false,
      stream: false,
      responses: true,
      tools: {
        required: true,
        definitions: [
          {
            name: 'finish',
            description: 'Finish the task.',
            parameters: {
              type: 'object',
              properties: { result: { type: 'string' } },
              required: ['result'],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    const response = await fetchAiTransport.request(request);
    expect(response.status).toBe(200);
    expect(parseToolResponse(resolved, response.body).calls).toMatchObject([
      { name: 'finish', arguments: { result: 'albert-ok' } },
    ]);
  }, 180_000);

  it('accepts image input on the default vision-capable model', async () => {
    const text = await runAi({
      provider: provider(),
      messages: [
        {
          role: 'user',
          content: 'Name the dominant color of this image in one English word.',
          images: [{ mimeType: 'image/png', data: redImage() }],
        },
      ],
      maxTokens: 8192,
      temperature: 0.1,
      json: false,
      stream: false,
    });
    expect(text).toMatch(/red/i);
  }, 180_000);

  it.skipIf(!audioFile)(
    'transcribes synthetic speech with usable segment timestamps',
    async () => {
      const resolved = provider();
      const transport: AiTransport = {
        ...fetchAiTransport,
        async request(request) {
          if (!request.audio) return fetchAiTransport.request(request);
          const form = new FormData();
          for (const [name, value] of request.audio.fields) form.append(name, value);
          form.append(
            request.audio.fileField,
            new Blob([new Uint8Array(readFileSync(audioFile!))], { type: 'audio/wav' }),
            'window.wav',
          );
          const response = await fetch(request.url, {
            method: 'POST',
            headers: request.headers,
            body: form,
            signal: request.signal,
          });
          return { status: response.status, headers: {}, body: await response.text() };
        },
      };
      const engine = createAlbertAsrEngine(transport, {
        get: async () => resolved.apiKey,
        listKeys: async () => ['ai.albert.apiKey'],
        set: async () => {},
        remove: async () => {},
      });
      const window = { index: 0, startMs: 0, endMs: 30_000 };
      const transcript = await engine.transcribeWindow(
        { jobId: 'synthetic', durationMs: 30_000, windows: [window] },
        window,
        { language: null, vocabulary: ['photosynthèse'] },
      );
      expect(transcript.segments.length).toBeGreaterThan(0);
      expect(transcript.segments.map((segment) => segment.text).join(' ')).toMatch(
        /photosynthèse/i,
      );
      expect(transcript.segments.some((segment) => segment.end > segment.start)).toBe(
        true,
      );
    },
    180_000,
  );
});
