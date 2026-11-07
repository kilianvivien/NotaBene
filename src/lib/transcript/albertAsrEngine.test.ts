import { describe, expect, it, vi } from 'vitest';
import { createAlbertAsrEngine } from '@/lib/adapters/asr/albertAsrEngine';
import { createAsrEngineRegistry } from '@/lib/adapters/asr/asrEngineRegistry';
import type { AiRequest, AiTransport } from '@/lib/adapters/ai/AiTransport';
import type { SecretsAdapter } from '@/lib/adapters/settings/SettingsAdapter';

const window = { index: 1, startMs: 297_000, endMs: 597_000 };
const job = { jobId: 'lecture-job', durationMs: 597_000, windows: [window] };
const options = { language: null, vocabulary: ['photosynthèse', 'chlorophylle'] };

function setup(payload: unknown, status = 200, hasKey = true) {
  const request = vi.fn(async (_request: AiRequest) => ({
    status,
    headers: {},
    body: JSON.stringify(payload),
  }));
  const transport: AiTransport = {
    request,
    async *stream() {
      throw new Error('unused');
      yield '';
    },
  };
  const secrets: SecretsAdapter = {
    get: async (name) => (hasKey && name === 'ai.albert.apiKey' ? 'secret' : null),
    set: async () => {},
    remove: async () => {},
    listKeys: async () => (hasKey ? ['ai.albert.apiKey'] : []),
  };
  return { engine: createAlbertAsrEngine(transport, secrets), request };
}

describe('Albert transcription', () => {
  it('uploads the named window as WAV and requests timestamped segments with vocabulary', async () => {
    const { engine, request } = setup({
      id: 'tr-1',
      model: 'whisper-large-v3',
      text: 'La photosynthèse.',
      segments: [
        { id: 0, text: 'La photosynthèse.', start: 0.5, end: 2.5, speaker: 'speaker_0' },
      ],
    });
    expect(engine.capabilities().window.seconds * 16_000 * 2 + 44).toBeLessThan(
      20_000_000,
    );
    await expect(engine.transcribeWindow(job, window, options)).resolves.toEqual({
      language: null,
      segments: [{ text: 'La photosynthèse.', start: 0.5, end: 2.5, words: [] }],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      url: 'https://albert.api.etalab.gouv.fr/v1/audio/transcriptions',
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
      audio: {
        jobId: job.jobId,
        index: 1,
        fileField: 'file',
        format: 'wav',
        fields: [
          ['model', 'whisper-large-v3'],
          ['response_format', 'diarized_json'],
          ['prompt', 'photosynthèse, chlorophylle'],
        ],
      },
      signal: undefined,
    });
  });

  it('omits language to avoid translation and omits unused vocabulary', async () => {
    const { engine, request } = setup({ text: '', segments: [] });
    await engine.transcribeWindow(job, window, { language: 'en', vocabulary: [] });
    const fields = request.mock.calls[0]![0].audio!.fields;
    expect(fields.map(([name]) => name)).toEqual(['model', 'response_format']);
  });

  it.each([
    { text: 'Hello', segments: [] },
    { text: 'Hello', segments: null },
    { text: 'Hello', segments: [{ text: 'Hello', start: -1, end: 2 }] },
    { text: 'Hello', segments: [{ text: 'Hello', start: 3, end: 2 }] },
    { text: 'Hello', segments: [{ text: 'Hello' }] },
  ])('rejects transcripts without usable timestamps: %j', async (payload) => {
    const { engine } = setup(payload);
    await expect(engine.transcribeWindow(job, window, options)).rejects.toThrow(
      'ASR_INVALID_RESPONSE',
    );
  });

  it('reports Albert failures without leaking the response or trying another model', async () => {
    const { engine, request } = setup({ detail: 'private lecture text' }, 429);
    await expect(engine.transcribeWindow(job, window, options)).rejects.toThrow(
      'ASR_ALBERT_API_ERROR: HTTP 429',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('requires the main Albert key, including at registry resolution', async () => {
    const { engine, request } = setup({}, 200, false);
    await expect(engine.status()).resolves.toEqual({ kind: 'not_configured' });
    const registry = createAsrEngineRegistry(engine, engine, engine);
    await expect(registry.resolveConfiguredEngine('albert-api')).rejects.toThrow(
      'ASR_ALBERT_KEY_MISSING',
    );
    await expect(engine.transcribeWindow(job, window, options)).rejects.toThrow(
      'ASR_ALBERT_KEY_MISSING',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('does not upload cancelled windows', async () => {
    const { engine, request } = setup({});
    await expect(
      engine.transcribeWindow(job, window, { ...options, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });
});
