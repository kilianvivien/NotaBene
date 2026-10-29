import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  parseResponse,
  parseStreamError,
  parseStreamFrame,
  parseToolResponse,
  ProviderRefusalError,
  ProviderTruncationError,
  readUsage,
} from './protocols';
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

  it('uses JSON Schema and an explicit stream flag for Apple', () => {
    const jsonSchema = {
      name: 'answer',
      schema: { type: 'object', properties: { title: { type: 'string' } } },
    };
    const body = bodyOf(resolved('apple', 'system'), true, jsonSchema);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { ...jsonSchema, strict: true },
    });
    expect(body.response_format).not.toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
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

  it.each([
    [
      'mistral',
      {
        choices: [
          {
            finish_reason: 'length',
            message: {
              content: [
                {
                  type: 'thinking',
                  thinking: [{ type: 'text', text: 'private analysis' }],
                },
              ],
            },
          },
        ],
      },
    ],
    [
      'anthropic',
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"links":[' }] },
    ],
    [
      'gemini',
      {
        candidates: [
          { finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"links":[' }] } },
        ],
      },
    ],
  ])(
    'reports a %s output cutoff before attempting to parse its text',
    (providerId, body) => {
      expect(() =>
        parseResponse(resolved(providerId as string), JSON.stringify(body)),
      ).toThrow(/output token limit/);
    },
  );

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

  it("surfaces an OpenAI-compatible provider's refusal in its own words", () => {
    const body = JSON.stringify({
      choices: [
        { message: { role: 'assistant', content: null, refusal: 'I cannot do that.' } },
      ],
    });
    expect(() => parseResponse(resolved('apple', 'system'), body)).toThrow(
      'I cannot do that.',
    );
  });
});

describe('parseStreamError', () => {
  it("reads Apple's in-stream context error frame", () => {
    const message = "The session's transcript exceeded the model's context size.";
    expect(parseStreamError(JSON.stringify({ error: { message } }))).toBe(message);
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

/**
 * Mistral's Responses endpoint, which only the agent asks for. Shapes are
 * trimmed from the documented examples.
 */
describe('Responses API', () => {
  const mistral = resolved('mistral', 'zai-glm-5-3');
  const tools: AiCall['tools'] = {
    definitions: [
      {
        name: 'read_note',
        description: 'Read a note.',
        parameters: { type: 'object', properties: { noteId: { type: 'string' } } },
      },
    ],
    required: true,
  };
  function call(overrides: Partial<AiCall> = {}): AiCall {
    return {
      provider: mistral,
      messages: [
        { role: 'system', content: 'Be careful.' },
        { role: 'user', content: 'hello' },
      ],
      maxTokens: 512,
      temperature: 0,
      json: false,
      stream: false,
      responses: true,
      ...overrides,
    };
  }

  it('is used only by calls that ask for it, on providers that serve it', () => {
    expect(buildRequest(call()).url).toBe('https://api.mistral.ai/v1/responses');
    expect(buildRequest(call({ responses: false })).url).toBe(
      'https://api.mistral.ai/v1/chat/completions',
    );
    expect(buildRequest(call({ provider: resolved('openrouter') })).url).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });

  it('sends instructions, typed input, tools and a stateless request', () => {
    const request = buildRequest(call({ tools, cacheKey: 'agent_1' }));
    const body = JSON.parse(request.body ?? '') as Record<string, unknown>;
    expect(request.headers.authorization).toBe('Bearer key');
    expect(body).toMatchObject({
      model: 'zai-glm-5-3',
      instructions: 'Be careful.',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      max_output_tokens: 512,
      tool_choice: 'required',
      parallel_tool_calls: true,
      prompt_cache_key: 'agent_1',
      tools: [
        {
          type: 'function',
          name: 'read_note',
          description: 'Read a note.',
          parameters: { type: 'object', properties: { noteId: { type: 'string' } } },
        },
      ],
    });
    // Mistral refuses server-side state on this endpoint.
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).not.toHaveProperty('text');
  });

  it('asks for structured output through text.format', () => {
    const schema = { name: 'plan', schema: { type: 'object' } };
    const body = JSON.parse(
      buildRequest(call({ json: true, jsonSchema: schema, reasoningEffort: 'low' })).body ??
        '',
    ) as Record<string, unknown>;
    expect(body.text).toEqual({
      format: { type: 'json_schema', name: 'plan', strict: false, schema: { type: 'object' } },
    });
    expect(body.reasoning).toEqual({ effort: 'low' });
    const plain = JSON.parse(buildRequest(call({ json: true })).body ?? '') as Record<
      string,
      unknown
    >;
    expect(plain.text).toEqual({ format: { type: 'json_object' } });
  });

  const answer = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    error: null,
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'private' }] },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Checking first.', annotations: [] }],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_a',
        name: 'read_note',
        arguments: '{"noteId":"n1"}',
      },
      {
        type: 'function_call',
        id: 'fc_2',
        call_id: 'call_b',
        name: 'read_note',
        arguments: 'not json',
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 },
  };

  it('reads calls, text and usage, and leaves the reasoning behind', () => {
    expect(parseToolResponse(mistral, JSON.stringify(answer))).toEqual({
      text: 'Checking first.',
      calls: [
        { id: 'call_a', name: 'read_note', arguments: { noteId: 'n1' } },
        { id: 'call_b', name: 'read_note', arguments: {} },
      ],
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    expect(parseResponse(mistral, JSON.stringify(answer))).toBe('Checking first.');
  });

  it('reports a response cut off by the output allowance', () => {
    const cut = {
      ...answer,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    };
    expect(() => parseResponse(mistral, JSON.stringify(cut))).toThrow(
      ProviderTruncationError,
    );
  });

  it('surfaces a failed response and a refusal in the provider’s words', () => {
    const failed = { ...answer, status: 'failed', error: { message: 'model overloaded' } };
    expect(() => parseResponse(mistral, JSON.stringify(failed))).toThrow('model overloaded');
    const refused = {
      ...answer,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        },
      ],
    };
    expect(() => parseResponse(mistral, JSON.stringify(refused))).toThrow(
      ProviderRefusalError,
    );
  });

  it('streams only the text deltas and reports failure events', () => {
    expect(
      parseStreamFrame(
        mistral,
        JSON.stringify({ type: 'response.output_text.delta', delta: 'Par' }),
      ),
    ).toBe('Par');
    expect(
      parseStreamFrame(
        mistral,
        JSON.stringify({ type: 'response.function_call_arguments.delta', delta: '{"' }),
      ),
    ).toBeNull();
    expect(parseStreamError(JSON.stringify({ type: 'error', message: 'bad key' }))).toBe(
      'bad key',
    );
    expect(
      parseStreamError(
        JSON.stringify({
          type: 'response.failed',
          response: { status: 'failed', error: { message: 'overloaded' } },
        }),
      ),
    ).toBe('overloaded');
    expect(
      parseStreamError(JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })),
    ).toBeNull();
  });
});

describe('readUsage', () => {
  it('reads each protocol’s own field names', () => {
    expect(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(readUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(
      readUsage({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, thoughtsTokenCount: 4 },
      }),
    ).toEqual({ inputTokens: 5, outputTokens: 5 });
  });

  it('never reads a missing count as zero', () => {
    expect(readUsage({})).toBeUndefined();
    expect(readUsage({ usage: { input_tokens: 7 } })).toBeUndefined();
  });
});

/** A vision prompt must contain the image bytes, not just a caption or asset id. */
describe('vision transport', () => {
  const image = { mimeType: 'image/png' as const, data: 'aW1hZ2U=' };
  function visionBody(id: string, responses = false) {
    return JSON.parse(
      buildRequest({
        provider: resolved(id),
        messages: [
          { role: 'system', content: 'Reconstruct' },
          { role: 'user', content: 'This chart', images: [image] },
        ],
        maxTokens: 2048,
        temperature: 0.1,
        json: true,
        stream: false,
        responses,
      }).body!,
    );
  }
  it.each(['openai', 'mistral', 'openrouter', 'ollama', 'lmstudio'])(
    'sends an inline image through %s chat completions',
    (id) => {
      const body = visionBody(id);
      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'This chart' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
        ],
      });
      expect(body.messages[0].content).toBe('Reconstruct');
    },
  );
  it('sends Anthropic base64 image blocks', () => {
    expect(visionBody('anthropic').messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: image.data },
    });
  });
  it('sends Gemini inlineData', () => {
    expect(visionBody('gemini').contents[0].parts).toContainEqual({ inlineData: image });
  });
  it('sends typed image inputs through Responses', () => {
    expect(visionBody('mistral', true).input[0].content).toContainEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,aW1hZ2U=',
    });
  });
});
