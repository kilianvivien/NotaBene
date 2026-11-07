import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/adapters';
import { AI_FEATURES, providerById } from './providers';
import { resolveFeature } from './resolve';
import {
  buildRequest,
  parseResponse,
  parseStreamFrame,
  parseToolResponse,
} from './protocols';

describe('Albert API', () => {
  it.each(AI_FEATURES)(
    'serves %s when Albert is the only connected provider',
    (feature) => {
      expect(resolveFeature(feature, DEFAULT_SETTINGS, ['albert'])).toMatchObject({
        available: true,
        definition: { id: 'albert' },
        baseUrl: 'https://albert.api.etalab.gouv.fr/v1',
        model: feature === 'agent' ? 'openweight-large' : 'openweight-medium',
      });
    },
  );

  it.each([
    'openweight-large',
    'openai/gpt-oss-120b',
    'openweight-code',
    'deepseek-v4-flash',
  ])('refuses image uploads to the known text-only model %s', (model) => {
    const settings = {
      ...DEFAULT_SETTINGS,
      aiFeatureModels: { default: { providerId: 'albert', model } },
    };
    expect(resolveFeature('imageDrawing', settings, ['albert'])).toEqual({
      available: false,
      reason: 'vision_required',
    });
    expect(resolveFeature('ask', settings, ['albert'])).toMatchObject({
      available: true,
      model,
    });
    expect(
      resolveFeature(
        'imageDrawing',
        {
          ...settings,
          aiFeatureModels: {
            ...settings.aiFeatureModels,
            imageDrawing: { providerId: 'albert', model: 'openweight-small' },
          },
        },
        ['albert'],
      ),
    ).toMatchObject({ available: true, model: 'openweight-small' });
  });

  const provider = {
    definition: providerById('albert')!,
    baseUrl: 'https://albert.api.etalab.gouv.fr/v1',
    apiKey: 'albert-test-key',
    model: 'openweight-medium',
  };
  const call = {
    provider,
    messages: [{ role: 'user' as const, content: 'Reply in JSON.' }],
    maxTokens: 8192,
    temperature: 0.2,
    json: true,
    stream: false,
  };

  it('uses Bearer auth and chat completions with guided JSON, including explicit non-streaming', () => {
    const request = buildRequest({
      ...call,
      jsonSchema: { name: 'answer', schema: { type: 'object' } },
    });
    expect(request.url).toBe(`${provider.baseUrl}/chat/completions`);
    expect(request.headers.authorization).toBe('Bearer albert-test-key');
    expect(JSON.parse(request.body!)).toMatchObject({
      model: 'openweight-medium',
      max_tokens: 8192,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: false, schema: { type: 'object' } },
      },
    });
    expect(
      parseResponse(
        provider,
        JSON.stringify({
          choices: [{ message: { content: '{"answer":"yes"}' } }],
        }),
      ),
    ).toBe('{"answer":"yes"}');
  });

  it('sends native tools through chat completions even when Responses is requested', () => {
    const request = buildRequest({
      ...call,
      responses: true,
      tools: {
        required: true,
        definitions: [
          { name: 'finish', description: 'Finish', parameters: { type: 'object' } },
        ],
      },
    });
    expect(request.url).toBe(`${provider.baseUrl}/chat/completions`);
    const body = JSON.parse(request.body!);
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0].function.name).toBe('finish');
    expect(body).not.toHaveProperty('response_format');
    expect(
      parseToolResponse(
        provider,
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'finish', arguments: '{"done":true}' },
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ calls: [{ name: 'finish', arguments: { done: true } }] });
  });

  it('uses OpenAI image content and streaming deltas', () => {
    const request = buildRequest({
      ...call,
      stream: true,
      messages: [
        {
          role: 'user',
          content: 'Reconstruct this diagram.',
          images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
        },
      ],
    });
    expect(JSON.parse(request.body!)).toMatchObject({
      stream: true,
      messages: [
        {
          content: [
            { type: 'text', text: 'Reconstruct this diagram.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
          ],
        },
      ],
    });
    expect(
      parseStreamFrame(provider, '{"choices":[{"delta":{"content":"Bonjour"}}]}'),
    ).toBe('Bonjour');
  });
});
