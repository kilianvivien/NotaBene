import { describe, expect, it } from 'vitest';
import { buildRequest, parseResponse, parseStreamFrame } from './protocols';
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

function bodyOf(
  provider: ResolvedProvider,
  json: boolean,
  jsonSchema?: AiCall['jsonSchema'],
): Record<string, unknown> {
  const call: AiCall = {
    provider,
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 256,
    temperature: 0.2,
    json,
    jsonSchema,
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

  it('sends no response_format to LM Studio when the call has no schema', () => {
    expect(bodyOf(resolved('lmstudio'), true)).not.toHaveProperty('response_format');
  });

  it('sends an explicit JSON Schema only where the provider asked for one', () => {
    const jsonSchema = {
      name: 'answer',
      schema: { type: 'object', properties: { title: { type: 'string' } } },
    };
    expect(bodyOf(resolved('lmstudio'), true, jsonSchema).response_format).toEqual({
      type: 'json_schema',
      json_schema: { ...jsonSchema, strict: true },
    });
    // Mistral takes the schema as guidance rather than as a contract: strict
    // validation rejects the agent's decision schema, which is a union at the
    // root.
    expect(bodyOf(resolved('mistral'), true, jsonSchema).response_format).toEqual({
      type: 'json_schema',
      json_schema: { ...jsonSchema, strict: false },
    });
    expect(bodyOf(resolved('openai'), true, jsonSchema).response_format).toEqual({
      type: 'json_object',
    });
  });

  it('still honours the other LM Studio fields', () => {
    const body = bodyOf(resolved('lmstudio', 'qwen3-8b-mlx'), true);
    expect(body).toMatchObject({
      model: 'qwen3-8b-mlx',
      max_tokens: 256,
      temperature: 0.2,
    });
  });
});

/**
 * The shapes below are trimmed copies of real Mistral answers. A thinking
 * model returns `content` as a list of typed chunks rather than as a string,
 * which the whole-response reader used to discard entirely — the agent, the
 * only feature that cannot stream, then failed on an HTTP 200.
 */
describe('parseResponse', () => {
  const mistral = resolved('mistral', 'zai-glm-5-3');

  it('reads a plain string answer', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"title":"T"}' } }],
    });
    expect(parseResponse(mistral, body)).toBe('{"title":"T"}');
  });

  it('reads a thinking model’s chunked answer and leaves the thinking behind', () => {
    const body = JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: [
                  { type: 'text', text: 'The user wants a summary. {not: "the answer"}' },
                ],
              },
              { type: 'text', text: '{"summary":"Résumé","steps":[]}' },
            ],
          },
        },
      ],
    });
    expect(parseResponse(mistral, body)).toBe('{"summary":"Résumé","steps":[]}');
  });

  it('still reports a body it genuinely cannot read', () => {
    const body = JSON.stringify({ choices: [{ message: { role: 'assistant' } }] });
    expect(() => parseResponse(mistral, body)).toThrow(/could not find text/);
  });
});

describe('parseStreamFrame', () => {
  const mistral = resolved('mistral', 'zai-glm-5-3');

  function frame(content: unknown): string {
    return JSON.stringify({ choices: [{ delta: { content } }] });
  }

  it('takes a string delta', () => {
    expect(parseStreamFrame(mistral, frame('Paris.'))).toBe('Paris.');
  });

  it('takes the text of a chunked delta and skips the thinking', () => {
    expect(parseStreamFrame(mistral, frame([{ type: 'text', text: 'Paris.' }]))).toBe(
      'Paris.',
    );
    expect(
      parseStreamFrame(
        mistral,
        frame([{ type: 'thinking', thinking: [{ type: 'text', text: 'The' }] }]),
      ),
    ).toBe('');
  });
});
