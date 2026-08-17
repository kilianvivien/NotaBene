/**
 * Wire formats.
 *
 * One function builds a request, one reads a whole response, one reads a
 * streamed frame — three times over, once per protocol. Everything above this
 * file works in `AiMessage`s and plain strings and never learns which provider
 * answered.
 *
 * Deliberately hand-rolled rather than four vendor SDKs: the surface we use is
 * one endpoint per provider, and four dependencies that each bundle a retry
 * policy, a fetch shim, and a telemetry hook is a poor trade for an app whose
 * whole claim is that nothing leaves the machine unasked.
 */
import type { AiRequest } from '@/lib/adapters';
import type { ProviderDefinition } from './providers';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ResolvedProvider {
  definition: ProviderDefinition;
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

export interface AiCall {
  provider: ResolvedProvider;
  messages: AiMessage[];
  maxTokens: number;
  temperature: number;
  /** Ask the provider to constrain output to JSON where it can. Not a
   * substitute for parsing — every response still goes through Zod. */
  json: boolean;
  /** A provider may use this to constrain structured output. It remains
   * optional because most providers already handle `json_object` reliably,
   * and changing their wire contract would risk a needless regression. */
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
  stream: boolean;
}

/** Trailing slashes turn `${base}/chat/completions` into a 404 that reads like
 * an auth failure. Normalising once here saves that support conversation. */
function base(provider: ResolvedProvider): string {
  return provider.baseUrl.replace(/\/+$/, '');
}

function splitSystem(messages: AiMessage[]): {
  system: string;
  rest: AiMessage[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  return { system, rest: messages.filter((message) => message.role !== 'system') };
}

export function buildRequest(call: AiCall): AiRequest {
  switch (call.provider.definition.protocol) {
    case 'anthropic':
      return anthropicRequest(call);
    case 'gemini':
      return geminiRequest(call);
    default:
      return openAiRequest(call);
  }
}

// -- Anthropic ---------------------------------------------------------------

function anthropicRequest(call: AiCall): AiRequest {
  const { system, rest } = splitSystem(call.messages);
  const quirks = call.provider.definition.quirks ?? {};
  return {
    url: `${base(call.provider)}/v1/messages`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': call.provider.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      // Only the browser build needs this; the desktop transport is not a
      // browser as far as the API is concerned. Harmless either way.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: call.provider.model,
      max_tokens: call.maxTokens,
      ...(quirks.sendTemperature === false ? {} : { temperature: call.temperature }),
      ...(system ? { system } : {}),
      messages: rest.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(call.stream ? { stream: true } : {}),
    }),
  };
}

// -- OpenAI-compatible (OpenAI, Mistral, OpenRouter, Ollama, LM Studio, …) ----

function openAiRequest(call: AiCall): AiRequest {
  const quirks = call.provider.definition.quirks ?? {};
  const tokenField = quirks.maxTokensField ?? 'max_tokens';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (call.provider.apiKey) {
    headers.authorization = `Bearer ${call.provider.apiKey}`;
  }

  return {
    url: `${base(call.provider)}/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: call.provider.model,
      messages: call.messages,
      [tokenField]: call.maxTokens,
      ...(quirks.sendTemperature === false ? {} : { temperature: call.temperature }),
      ...openAiResponseFormat(call),
      ...(call.stream ? { stream: true } : {}),
    }),
  };
}

function openAiResponseFormat(call: AiCall): Record<string, unknown> {
  if (!call.json) return {};
  const quirks = call.provider.definition.quirks ?? {};
  if (quirks.jsonSchemaMode && call.jsonSchema) {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: call.jsonSchema.name,
          strict: true,
          schema: call.jsonSchema.schema,
        },
      },
    };
  }
  return quirks.jsonMode === false ? {} : { response_format: { type: 'json_object' } };
}

// -- Gemini ------------------------------------------------------------------

function geminiRequest(call: AiCall): AiRequest {
  const { system, rest } = splitSystem(call.messages);
  const quirks = call.provider.definition.quirks ?? {};
  const method = call.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return {
    // The key goes in a header, not the query string, so it cannot end up in a
    // proxy log or a crash report alongside the URL.
    url: `${base(call.provider)}/models/${encodeURIComponent(call.provider.model)}:${method}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': call.provider.apiKey ?? '',
    },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: rest.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: {
        maxOutputTokens: call.maxTokens,
        ...(quirks.sendTemperature === false ? {} : { temperature: call.temperature }),
        ...(call.json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  };
}

// -- Reading responses -------------------------------------------------------

/** Pull the assistant's text out of a complete response body. Throws with the
 * provider's own words when the body is an error document, because "your
 * credit balance is too low" is infinitely more useful than "AI call failed". */
export function parseResponse(provider: ResolvedProvider, body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`provider returned non-JSON: ${body.slice(0, 200)}`);
  }

  const error = providerError(payload);
  if (error) throw new Error(error);

  const text = extractText(provider.definition.protocol, payload);
  if (text === null) {
    throw new Error(`could not find text in provider response: ${body.slice(0, 200)}`);
  }
  return text;
}

function providerError(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (typeof error === 'string') return error;
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function extractText(protocol: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  if (protocol === 'anthropic') {
    const content = payload.content;
    if (!Array.isArray(content)) return null;
    return content
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('');
  }

  if (protocol === 'gemini') {
    const candidates = payload.candidates;
    if (!Array.isArray(candidates)) return null;
    const first = candidates[0];
    if (!isRecord(first) || !isRecord(first.content)) return null;
    const parts = first.content.parts;
    if (!Array.isArray(parts)) return null;
    return parts
      .filter((part): part is Record<string, unknown> => isRecord(part))
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }

  const choices = payload.choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === 'string' ? content : null;
}

/**
 * Read one SSE payload. Returns the text delta it carries, or `null` for the
 * many frames that carry none — keep-alives, role announcements, usage
 * summaries, and the `[DONE]` sentinel. Malformed frames are `null` too: a
 * stream is best-effort progress, and the non-streamed path is what the
 * features fall back on.
 */
export function parseStreamFrame(
  provider: ResolvedProvider,
  payload: string,
): string | null {
  if (!payload || payload === '[DONE]') return null;

  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(frame)) return null;

  switch (provider.definition.protocol) {
    case 'anthropic': {
      if (frame.type !== 'content_block_delta') return null;
      const delta = frame.delta;
      if (!isRecord(delta) || typeof delta.text !== 'string') return null;
      return delta.text;
    }
    case 'gemini':
      return extractText('gemini', frame);
    default: {
      const choices = frame.choices;
      if (!Array.isArray(choices)) return null;
      const first = choices[0];
      if (!isRecord(first) || !isRecord(first.delta)) return null;
      const content = first.delta.content;
      return typeof content === 'string' ? content : null;
    }
  }
}

/** An error frame mid-stream. Providers send these instead of closing, and a
 * silent truncation would look to the user like a short answer. */
export function parseStreamError(payload: string): string | null {
  if (!payload || payload === '[DONE]') return null;
  try {
    return providerError(JSON.parse(payload));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
