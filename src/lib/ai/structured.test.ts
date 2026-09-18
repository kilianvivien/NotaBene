/**
 * The second try.
 *
 * `json.ts` reads a messy answer generously; this is what happens when even
 * that fails. The three things worth pinning down: a model that answers
 * correctly is never asked twice, a model that answers badly is asked exactly
 * once more and shown what it wrote, and a student who cancelled is not billed
 * for a repair they did not ask for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { providerById } from './providers';
import type { ResolvedProvider } from './protocols';
import { runStructured } from './structured';

const Simple = z.object({ title: z.string() });

const provider: ResolvedProvider = {
  definition: providerById('ollama')!,
  baseUrl: 'http://localhost:11434/v1',
  apiKey: null,
  model: 'qwen2.5',
};

/** The provider that asks for a JSON Schema on the wire. */
const mistral: ResolvedProvider = {
  definition: providerById('mistral')!,
  baseUrl: 'https://api.mistral.ai/v1',
  apiKey: 'test-key',
  model: 'zai-glm-5-3',
};

const call = {
  provider,
  messages: [{ role: 'user' as const, content: 'summarise this' }],
  maxTokens: 100,
  temperature: 0.3,
};

/** An OpenAI-shaped 200 carrying whatever the model "said". */
function answered(content: string) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a structured call', () => {
  it('asks once when the answer parses', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const request = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValue(answered('{"title": "T"}'));

    await expect(runStructured(call, Simple)).resolves.toEqual({ title: 'T' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows the model its own broken answer and takes the correction', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const request = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValueOnce(answered('I am not going to write JSON today.'))
      .mockResolvedValueOnce(answered('{"title": "T"}'));

    await expect(runStructured(call, Simple)).resolves.toEqual({ title: 'T' });
    expect(request).toHaveBeenCalledTimes(2);

    const second = JSON.parse(String(request.mock.calls[1]?.[0].body)) as {
      messages: { role: string; content: string }[];
      temperature?: number;
    };
    // The original question, the model's answer, and the complaint — a repair
    // turn, not the same request sent again.
    expect(second.messages[0]?.content).toBe('summarise this');
    expect(second.messages[1]).toEqual({
      role: 'assistant',
      content: 'I am not going to write JSON today.',
    });
    expect(second.messages[2]?.content).toMatch(/valid JSON/);
    expect(second.temperature).toBe(0);
  });

  it('drops a rejected JSON Schema and asks again in plain JSON mode', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const request = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValueOnce({ status: 400, headers: {}, body: 'unsupported schema' })
      .mockResolvedValueOnce(answered('{"title": "T"}'));

    const schema = { name: 'answer', schema: { type: 'object' } };
    await expect(
      runStructured({ ...call, provider: mistral, jsonSchema: schema }, Simple),
    ).resolves.toEqual({ title: 'T' });
    expect(request).toHaveBeenCalledTimes(2);

    const first = JSON.parse(String(request.mock.calls[0]?.[0].body)) as {
      response_format?: { type: string };
    };
    const second = JSON.parse(String(request.mock.calls[1]?.[0].body)) as {
      response_format?: { type: string };
    };
    expect(first.response_format?.type).toBe('json_schema');
    expect(second.response_format?.type).toBe('json_object');
  });

  it('does not retry a rejection that has nothing to do with the schema', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const request = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValue({ status: 401, headers: {}, body: 'bad key' });

    await expect(runStructured({ ...call, provider: mistral }, Simple)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('gives up after the second try, reporting what came back last', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const request = vi
      .spyOn(aiTransport, 'request')
      .mockResolvedValueOnce(answered('nope'))
      .mockResolvedValueOnce(answered('still nope'));

    await expect(runStructured(call, Simple)).rejects.toThrow(
      expect.objectContaining({ raw: 'still nope' }) as Error,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a run the student cancelled', async () => {
    const { aiTransport } = await import('@/lib/adapters');
    const controller = new AbortController();
    const request = vi.spyOn(aiTransport, 'request').mockImplementation(async () => {
      // The cancel lands while the first answer is on its way back.
      controller.abort();
      return answered('half an ans');
    });

    await expect(
      runStructured(call, Simple, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
