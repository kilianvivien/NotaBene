import { describe, expect, it, vi } from 'vitest';
import type { AiRequest, AiTransport } from '@/lib/adapters/ai/AiTransport';
import type { SecretsAdapter } from '@/lib/adapters/settings/SettingsAdapter';
import { createMistralAsrEngine } from '@/lib/adapters/asr/mistralAsrEngine';

const window = { index: 2, startMs: 1_194_000, endMs: 1_794_000 };
const job = { jobId: 'lecture-job', durationMs: 1_794_000, windows: [window] };
const options = { language: null, vocabulary: ['Alder Creek Design', 'photosynthèse'] };

function setup(body: unknown, status = 200) {
  const request = vi.fn(async (_request: AiRequest) => ({
    status,
    headers: {},
    body: JSON.stringify(body),
  }));
  const transport: AiTransport = {
    request,
    async *stream() {
      throw new Error('unused');
      yield '';
    },
  };
  const secrets: SecretsAdapter = {
    get: async (name) => (name === 'ai.mistral.apiKey' ? 'secret' : null),
    set: async () => {},
    remove: async () => {},
    listKeys: async () => ['ai.mistral.apiKey'],
  };
  return { engine: createMistralAsrEngine(transport, secrets), request };
}

describe('Mistral Voxtral 3 transcription', () => {
  it('names the audio window and requests segment timestamps, language and phrase hints', async () => {
    const { engine, request } = setup({
      language: 'fr',
      segments: [{ text: 'La photosynthèse.', start: 0.5, end: 2.5 }],
    });
    await expect(engine.transcribeWindow(job, window, options)).resolves.toEqual({
      language: 'fr',
      segments: [{ text: 'La photosynthèse.', start: 0.5, end: 2.5, words: [] }],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      url: 'https://api.mistral.ai/v1/audio/transcriptions',
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
      audio: {
        jobId: job.jobId,
        index: window.index,
        fileField: 'file',
        fields: [
          ['model', 'voxtral-mini-transcribe-3-0'],
          ['timestamp_granularities', 'segment'],
          ['return_language', 'true'],
          ['context_bias', 'Alder Creek Design'],
          ['context_bias', 'photosynthèse'],
        ],
      },
      signal: undefined,
    });
  });

  it('keeps overlapping segments in provider order without inventing word timings', async () => {
    const { engine } = setup({
      language: null,
      segments: [
        { text: 'One speaker.', start: 0, end: 3, speaker_id: 'speaker_0' },
        { text: 'Another speaker.', start: 2, end: 4, speaker_id: 'speaker_1' },
      ],
    });
    await expect(engine.transcribeWindow(job, window, options)).resolves.toEqual({
      language: null,
      segments: [
        { text: 'One speaker.', start: 0, end: 3, words: [] },
        { text: 'Another speaker.', start: 2, end: 4, words: [] },
      ],
    });
  });

  it('accepts silence but refuses spoken text without usable timestamps', async () => {
    const silent = setup({ text: '', segments: [] });
    await expect(silent.engine.transcribeWindow(job, window, options)).resolves.toEqual({
      language: null,
      segments: [],
    });
    const untimed = setup({ text: 'Hello.', segments: [] });
    await expect(untimed.engine.transcribeWindow(job, window, options)).rejects.toThrow(
      /ASR_INVALID_RESPONSE.*no timestamps/,
    );
    const malformed = setup({ segments: [{ text: 'Hello.', start: -1, end: 2 }] });
    await expect(malformed.engine.transcribeWindow(job, window, options)).rejects.toThrow(
      /ASR_INVALID_RESPONSE/,
    );
  });

  it('reports a Voxtral 3 API failure without trying an older model', async () => {
    const { engine, request } = setup({ message: 'Invalid model' }, 400);
    await expect(engine.transcribeWindow(job, window, options)).rejects.toThrow(
      'ASR_API_ERROR: 400 Invalid model',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not upload an already cancelled window', async () => {
    const { engine, request } = setup({});
    const signal = AbortSignal.abort();
    await expect(
      engine.transcribeWindow(job, window, { ...options, signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });
});
