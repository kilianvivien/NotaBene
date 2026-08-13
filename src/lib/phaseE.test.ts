/**
 * Phase E — AI core.
 *
 * Three things are worth a test here, and they are the three that lose trust
 * when they break: that a malformed model response cannot touch a note, that
 * accepting a subset of a diff means exactly that subset, and that every
 * provider's request goes to the right place with the right auth. The rest of
 * the phase is UI over these.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AI_PROVIDERS,
  applyProposal,
  buildRequest,
  estimateTokens,
  extractJson,
  MAX_INPUT_TOKENS,
  parseModelJson,
  parseResponse,
  parseStreamFrame,
  preflight,
  providerById,
  resolveFeature,
  runAi,
  secretKeyFor,
  type ResolvedProvider,
} from '@/lib/ai';
import { SseBuffer } from '@/lib/adapters/ai/sse';
import { DEFAULT_SETTINGS, type AppSettings } from '@/lib/adapters';
import {
  AiRewriteResponseSchema,
  AiSynthesisResponseSchema,
  type NoteDoc,
  type RewriteProposal,
} from '@/lib/schema';

function resolved(providerId: string, model = 'test-model'): ResolvedProvider {
  const definition = providerById(providerId)!;
  return {
    definition,
    baseUrl: definition.defaultBaseUrl || 'https://example.test/v1',
    apiKey: 'sk-test',
    model,
  };
}

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

// ---------------------------------------------------------------------------
// The garbage test the exit criteria ask for
// ---------------------------------------------------------------------------

describe('a malformed model response never reaches a note', () => {
  const garbage = [
    '',
    'Sure! I can help with that.',
    '{"blocks": [',
    '{"blocks": "not an array"}',
    '{"blocks": [{"index": -1, "action": "replace", "markdown": "x"}]}',
    '{"blocks": [{"index": 0, "action": "delete", "markdown": "x"}]}',
    // "replace" with nothing to replace it with: syntactically fine, and the
    // one shape that would silently blank a block if it got through.
    '{"blocks": [{"index": 0, "action": "replace", "markdown": "   "}]}',
    '<!doctype html><title>401 Unauthorized</title>',
  ];

  for (const payload of garbage) {
    it(`rejects ${JSON.stringify(payload.slice(0, 40))}`, () => {
      expect(() => parseModelJson(AiRewriteResponseSchema, payload)).toThrow();
    });
  }

  it('accepts a well-formed proposal, including the empty one', () => {
    expect(parseModelJson(AiRewriteResponseSchema, '{"blocks": []}').blocks).toEqual([]);
    const parsed = parseModelJson(
      AiRewriteResponseSchema,
      '{"blocks": [{"index": 2, "action": "remove"}]}',
    );
    expect(parsed.blocks[0]).toMatchObject({ index: 2, action: 'remove' });
  });

  it('digs the object out of a fenced or chatty response', () => {
    const fenced = '```json\n{"title": "T", "markdown": "body"}\n```';
    expect(parseModelJson(AiSynthesisResponseSchema, fenced).title).toBe('T');

    const chatty =
      'Here you go:\n{"title": "T", "markdown": "with a { brace }"}\nHope that helps!';
    expect(parseModelJson(AiSynthesisResponseSchema, chatty).markdown).toBe(
      'with a { brace }',
    );
  });

  it('does not stop at a brace inside a string literal', () => {
    const tricky = '{"title": "a \\" and a }", "markdown": "b"}';
    expect(extractJson(tricky)).toBe(tricky);
  });
});

// ---------------------------------------------------------------------------
// The diff gate
// ---------------------------------------------------------------------------

describe('applying a rewrite proposal', () => {
  const doc: NoteDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
    ],
  };

  const proposal: RewriteProposal = {
    blocks: [
      {
        index: 0,
        action: 'replace',
        node: { type: 'paragraph', content: [{ type: 'text', text: 'ONE' }] },
      },
      { index: 1, action: 'remove' },
      {
        index: 2,
        action: 'insert',
        node: { type: 'paragraph', content: [{ type: 'text', text: 'inserted' }] },
      },
    ],
  };

  function texts(result: NoteDoc): string[] {
    return result.content.map((node) => String(node.content?.[0]?.text ?? ''));
  }

  it('changes nothing when nothing is accepted', () => {
    expect(texts(applyProposal(doc, proposal, new Set()))).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('applies exactly the accepted entries', () => {
    expect(texts(applyProposal(doc, proposal, new Set([0])))).toEqual([
      'ONE',
      'two',
      'three',
    ]);
    expect(texts(applyProposal(doc, proposal, new Set([1])))).toEqual(['one', 'three']);
    expect(texts(applyProposal(doc, proposal, new Set([2])))).toEqual([
      'one',
      'two',
      'inserted',
      'three',
    ]);
  });

  it('keeps later indexes meaningful when an earlier entry is rejected', () => {
    // Rejecting the removal at index 1 must not shift where the insert lands.
    expect(texts(applyProposal(doc, proposal, new Set([0, 2])))).toEqual([
      'ONE',
      'two',
      'inserted',
      'three',
    ]);
  });

  it('never produces a document the editor cannot mount', () => {
    const removeAll: RewriteProposal = {
      blocks: doc.content.map((_, index) => ({ index, action: 'remove' as const })),
    };
    const result = applyProposal(doc, removeAll, new Set([0, 1, 2]));
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

describe('provider catalogue', () => {
  it('keeps every built-in default in its suggested model list', () => {
    for (const provider of AI_PROVIDERS) {
      if (provider.defaultModel) {
        expect(provider.models).toContain(provider.defaultModel);
      }
    }
  });

  it('offers the current balanced cloud-provider defaults', () => {
    expect(providerById('anthropic')).toMatchObject({
      defaultModel: 'claude-sonnet-5',
      models: expect.arrayContaining(['claude-sonnet-5', 'claude-haiku-4-5-20251001']),
    });
    expect(providerById('openai')).toMatchObject({
      defaultModel: 'gpt-5.6-terra',
      models: expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    });
    expect(providerById('gemini')).toMatchObject({
      defaultModel: 'gemini-3.7-flash',
      models: expect.arrayContaining(['gemini-3.7-flash', 'gemini-3.5-flash-lite']),
    });
  });
});

describe('provider requests', () => {
  const messages = [
    { role: 'system' as const, content: 'be brief' },
    { role: 'user' as const, content: 'hello' },
  ];

  function request(providerId: string) {
    return buildRequest({
      provider: resolved(providerId),
      messages,
      maxTokens: 100,
      temperature: 0.3,
      json: false,
      stream: false,
    });
  }

  it('sends Anthropic its own header and hoists the system message', () => {
    const built = request('anthropic');
    expect(built.url).toBe('https://api.anthropic.com/v1/messages');
    expect(built.headers['x-api-key']).toBe('sk-test');
    expect(built.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(built.body!);
    expect(body.system).toBe('be brief');
    expect(body.messages).toHaveLength(1);
    expect(body.temperature).toBeUndefined();
  });

  it('sends Mistral a bearer token at its own base URL', () => {
    const built = request('mistral');
    expect(built.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(built.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(built.body!);
    // Mistral takes the classic field and the temperature; only OpenAI's own
    // newer models are fussy about either.
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.3);
    expect(body.messages).toHaveLength(2);
  });

  it("honours OpenAI's renamed token field and its temperature restriction", () => {
    const body = JSON.parse(request('openai').body!);
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('keeps the Gemini key in a header rather than the query string', () => {
    const built = request('gemini');
    expect(built.url).not.toContain('sk-test');
    expect(built.headers['x-goog-api-key']).toBe('sk-test');
    const body = JSON.parse(built.body!);
    expect(body.systemInstruction.parts[0].text).toBe('be brief');
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  it('sends no Authorization header to a keyless local runtime', () => {
    const built = buildRequest({
      provider: { ...resolved('ollama'), apiKey: null },
      messages,
      maxTokens: 100,
      temperature: 0.3,
      json: false,
      stream: false,
    });
    expect(built.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(built.headers.authorization).toBeUndefined();
  });

  it('normalises a base URL the user typed with a trailing slash', () => {
    const provider = resolved('custom');
    provider.baseUrl = 'https://gpu.example.edu/v1/';
    const built = buildRequest({
      provider,
      messages,
      maxTokens: 10,
      temperature: 0,
      json: false,
      stream: false,
    });
    expect(built.url).toBe('https://gpu.example.edu/v1/chat/completions');
  });
});

describe('provider responses', () => {
  it('reads text out of each protocol', () => {
    expect(
      parseResponse(resolved('anthropic'), '{"content":[{"type":"text","text":"hi"}]}'),
    ).toBe('hi');
    expect(
      parseResponse(resolved('mistral'), '{"choices":[{"message":{"content":"hi"}}]}'),
    ).toBe('hi');
    expect(
      parseResponse(
        resolved('gemini'),
        '{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',
      ),
    ).toBe('hi');
  });

  it("surfaces the provider's own error message", () => {
    expect(() =>
      parseResponse(resolved('mistral'), '{"error":{"message":"no credit"}}'),
    ).toThrow(/no credit/);
  });

  it('reads a streamed delta from each protocol and ignores the noise', () => {
    expect(
      parseStreamFrame(
        resolved('anthropic'),
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}',
      ),
    ).toBe('a');
    expect(parseStreamFrame(resolved('anthropic'), '{"type":"ping"}')).toBeNull();
    expect(
      parseStreamFrame(resolved('mistral'), '{"choices":[{"delta":{"content":"a"}}]}'),
    ).toBe('a');
    expect(parseStreamFrame(resolved('mistral'), '[DONE]')).toBeNull();
    expect(parseStreamFrame(resolved('mistral'), 'not json at all')).toBeNull();
  });
});

describe('SSE reframing', () => {
  it('holds a partial frame until its blank line arrives', () => {
    const buffer = new SseBuffer();
    expect(buffer.push('data: {"a"')).toEqual([]);
    expect(buffer.push(':1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles CRLF framing and a stream that ends without a blank line', () => {
    const buffer = new SseBuffer();
    expect(buffer.push('data: one\r\n\r\n')).toEqual(['one']);
    expect(buffer.push('data: two')).toEqual([]);
    expect(buffer.flush()).toEqual(['two']);
  });
});

// ---------------------------------------------------------------------------
// Resolution, preflight, and the promise that nothing runs unasked
// ---------------------------------------------------------------------------

describe('feature resolution', () => {
  it('reports no provider rather than guessing when nothing is configured', () => {
    const result = resolveFeature('rewrite', settingsWith(), []);
    expect(result).toEqual({ available: false, reason: 'no_provider' });
  });

  it('does not reach for a local runtime the user never switched on', () => {
    // Ollama needs no key, which must not be mistaken for consent: a machine
    // without it installed should say "connect a provider", not fail on a
    // connection refused halfway through the first rewrite.
    expect(resolveFeature('rewrite', settingsWith(), []).available).toBe(false);

    const enabled = settingsWith({
      aiProviders: { ollama: { enabled: true, baseUrl: null, extraModels: [] } },
    });
    const result = resolveFeature('rewrite', enabled, []);
    if (!result.available) throw new Error('expected Ollama to resolve');
    expect(result.definition.id).toBe('ollama');
  });

  it('falls through to the only keyed provider when a feature names none', () => {
    const result = resolveFeature('rewrite', settingsWith(), ['mistral']);
    expect(result).toMatchObject({ available: true });
    if (result.available) {
      expect(result.definition.id).toBe('mistral');
      expect(result.model).toBe('mistral-medium-latest');
    }
  });

  it('does not carry a model across a provider it fell through', () => {
    // Anthropic is chosen but has no key; resolution lands on Mistral and must
    // not ask Mistral for a Claude model.
    const settings = settingsWith({
      aiFeatureModels: { rewrite: { providerId: 'anthropic', model: 'claude-opus-5' } },
    });
    const result = resolveFeature('rewrite', settings, ['mistral']);
    if (!result.available) throw new Error('expected a provider');
    expect(result.definition.id).toBe('mistral');
    expect(result.model).not.toBe('claude-opus-5');
  });

  it('uses the default row for a feature that has no row of its own', () => {
    const settings = settingsWith({
      aiFeatureModels: {
        default: { providerId: 'mistral', model: 'mistral-large-latest' },
      },
    });
    const result = resolveFeature('ask', settings, ['mistral']);
    if (!result.available) throw new Error('expected a provider');
    expect(result.model).toBe('mistral-large-latest');
  });

  it('prefixes secret names so a provider id cannot collide with another secret', () => {
    expect(secretKeyFor('mistral')).toBe('ai.mistral.apiKey');
  });
});

describe('preflight', () => {
  it('estimates in the right order of magnitude', () => {
    expect(estimateTokens('a'.repeat(360))).toBe(100);
  });

  it('refuses an oversized payload before anything leaves the machine', async () => {
    const huge = 'x'.repeat(MAX_INPUT_TOKENS * 4);
    expect(preflight({ messages: [{ role: 'user', content: huge }] }).withinLimit).toBe(
      false,
    );

    const transport = await import('@/lib/adapters');
    const spy = vi.spyOn(transport.aiTransport, 'request');
    await expect(
      runAi({
        provider: resolved('mistral'),
        messages: [{ role: 'user', content: huge }],
        maxTokens: 10,
        temperature: 0,
        json: false,
        stream: false,
      }),
    ).rejects.toThrow(/limit/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the request engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const call = {
    provider: resolved('mistral'),
    messages: [{ role: 'user' as const, content: 'hi' }],
    maxTokens: 10,
    temperature: 0,
    json: false,
    stream: false,
  };

  it('retries a rate limit and gives up on a bad key', async () => {
    const transport = await import('@/lib/adapters');
    const request = vi
      .spyOn(transport.aiTransport, 'request')
      .mockResolvedValueOnce({ status: 429, headers: {}, body: '{}' })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"choices":[{"message":{"content":"ok"}}]}',
      });

    const pending = runAi(call);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);

    request.mockReset();
    request.mockResolvedValue({
      status: 401,
      headers: {},
      body: '{"error":{"message":"bad key"}}',
    });
    await expect(runAi(call)).rejects.toThrow(/rejected the API key/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('lets go of a call the transport cannot take back', async () => {
    const transport = await import('@/lib/adapters');
    // What the desktop transport does: the request is handed to Rust, and the
    // promise settles when the model finishes — cancel or no cancel. The
    // provider is told to stop separately; this is about the student getting
    // the dialog back rather than watching a spinner for another two minutes.
    vi.spyOn(transport.aiTransport, 'request').mockReturnValue(new Promise(() => {}));

    const controller = new AbortController();
    const pending = runAi(call, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('stops on cancellation without retrying', async () => {
    const transport = await import('@/lib/adapters');
    const request = vi
      .spyOn(transport.aiTransport, 'request')
      .mockResolvedValue({ status: 503, headers: {}, body: '{}' });

    const controller = new AbortController();
    const pending = runAi(call, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
