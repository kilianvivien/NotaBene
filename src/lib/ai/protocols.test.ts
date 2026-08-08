import { describe, expect, it } from 'vitest';
import { buildRequest } from './protocols';
import type { AiCall, ResolvedProvider } from './protocols';
import { providerById } from './providers';

function resolved(id: string, model = 'a-model'): ResolvedProvider {
  const definition = providerById(id);
  if (!definition) throw new Error(`no provider ${id}`);
  return {
    definition,
    baseUrl: definition.defaultBaseUrl || 'http://localhost:1234/v1',
    apiKey: definition.requiresKey ? 'key' : null,
    model,
  };
}

function bodyOf(provider: ResolvedProvider, json: boolean): Record<string, unknown> {
  const call: AiCall = {
    provider,
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 256,
    temperature: 0.2,
    json,
    stream: false,
  };
  return JSON.parse(buildRequest(call).body ?? '') as Record<string, unknown>;
}

describe('openAiRequest', () => {
  it('asks for JSON mode where the server takes it', () => {
    expect(bodyOf(resolved('mistral'), true).response_format).toEqual({
      type: 'json_object',
    });
  });

  it('never asks for it on a prose call', () => {
    expect(bodyOf(resolved('mistral'), false)).not.toHaveProperty('response_format');
  });

  // LM Studio accepts only `json_schema` and `text`, and answers `json_object`
  // with a 400 that takes rewrite and synthesis down with it.
  it('sends no response_format to LM Studio', () => {
    expect(bodyOf(resolved('lmstudio'), true)).not.toHaveProperty('response_format');
  });

  it('still honours the other LM Studio fields', () => {
    const body = bodyOf(resolved('lmstudio', 'qwen3-8b-mlx'), true);
    expect(body).toMatchObject({ model: 'qwen3-8b-mlx', max_tokens: 256, temperature: 0.2 });
  });
});
