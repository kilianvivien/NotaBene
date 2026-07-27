/**
 * The one place a model is actually called.
 *
 * Retry, timeout, cancellation, streaming and preflight live here rather than
 * in each feature, because every one of them is a decision you want made the
 * same way whether the user pressed Rewrite or asked a question. Features
 * describe *what* to ask; this decides how long to wait and when to give up.
 *
 * The cancel button is the reason streaming exists at all. A student who
 * pointed a 70-billion-parameter local model at a forty-page lecture note needs
 * to be able to change their mind, and a spinner they cannot interrupt is worse
 * than no progress indicator at all.
 */
import { aiTransport } from '@/lib/adapters';
import { buildRequest, parseResponse, parseStreamError, parseStreamFrame } from './protocols';
import type { AiCall } from './protocols';

/** Default ceiling for one call. Generous because a local model on a laptop is
 * genuinely slow, and a timeout that fires mid-answer is the worst outcome. */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** Transient failures only. A 401 will still be a 401 in four seconds. */
const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export interface AiRunOptions {
  signal?: AbortSignal;
  /** Called with each token as it arrives. Its presence is what turns
   * streaming on — a caller that cannot show partial text gains nothing from
   * it and loses the cleaner error reporting of a whole response. */
  onToken?(text: string): void;
  timeoutMs?: number;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * Rough token count. Used for the preflight figure the UI shows before a run
 * and for the hard input ceiling, neither of which needs to be exact — they
 * need to catch "you are about to send a 300-page book".
 *
 * ~3.6 characters per token splits the difference between English and French;
 * French runs longer per token, and half this app's users write in it.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** Refuse rather than send. The number is well under every current model's
 * window, so hitting it means something is wrong with the selection, not with
 * the model. */
export const MAX_INPUT_TOKENS = 150_000;

export interface Preflight {
  characters: number;
  estimatedTokens: number;
  withinLimit: boolean;
}

export function preflight(call: Pick<AiCall, 'messages'>): Preflight {
  const characters = call.messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  const estimatedTokens = Math.ceil(characters / 3.6);
  return {
    characters,
    estimatedTokens,
    withinLimit: estimatedTokens <= MAX_INPUT_TOKENS,
  };
}

export async function runAi(call: AiCall, options: AiRunOptions = {}): Promise<string> {
  const check = preflight(call);
  if (!check.withinLimit) {
    throw new AiError(
      `input is about ${check.estimatedTokens} tokens, over the ${MAX_INPUT_TOKENS} limit`,
    );
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await attemptCall(call, options);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AiError && error.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS || options.signal?.aborted) break;
      // Exponential, because the common retryable case is a rate limit and
      // hammering it is how you stay rate-limited.
      await delay(600 * 2 ** (attempt - 1), options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new AiError(String(lastError));
}

async function attemptCall(call: AiCall, options: AiRunOptions): Promise<string> {
  const streaming = Boolean(options.onToken);
  const request = buildRequest({ ...call, stream: streaming });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('timed out', 'TimeoutError')),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const forward = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forward, { once: true });

  try {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const signed = { ...request, signal: controller.signal };
    return streaming
      ? await readStream(call, signed, options)
      : await readWhole(call, signed);
  } catch (error) {
    throw asAiError(error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forward);
  }
}

async function readWhole(
  call: AiCall,
  request: Parameters<typeof aiTransport.request>[0],
): Promise<string> {
  const response = await aiTransport.request(request);
  if (response.status >= 400) {
    throw new AiError(
      describeStatus(response.status, response.body),
      response.status,
      RETRY_STATUSES.has(response.status),
    );
  }
  return parseResponse(call.provider, response.body);
}

async function readStream(
  call: AiCall,
  request: Parameters<typeof aiTransport.stream>[0],
  options: AiRunOptions,
): Promise<string> {
  let text = '';
  for await (const payload of aiTransport.stream(request)) {
    const failure = parseStreamError(payload);
    if (failure) throw new AiError(failure);

    const delta = parseStreamFrame(call.provider, payload);
    if (delta) {
      text += delta;
      options.onToken?.(delta);
    }
  }
  if (!text) throw new AiError('the model returned nothing');
  return text;
}

/** Turn transport-level failures into something a person can act on. */
function asAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AiError('cancelled');
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new AiError('the provider did not answer in time', undefined, true);
  }

  const message = error instanceof Error ? error.message : String(error);
  // The Rust transport reports a failed stream as "<status> <body>"; recover
  // the status so retry and the message stay as good as on the whole-response
  // path.
  const status = Number(/^(\d{3})\b/.exec(message)?.[1] ?? NaN);
  if (Number.isFinite(status)) {
    return new AiError(
      describeStatus(status, message.slice(4)),
      status,
      RETRY_STATUSES.has(status),
    );
  }
  // A network-level failure — endpoint down, laptop asleep, Ollama not
  // running — is worth one more go. It is also the one failure whose native
  // message ("Failed to fetch", "error sending request") tells a student
  // nothing at all, so it gets the endpoint named back at them.
  return new AiError(`could not reach the provider (${message})`, undefined, true);
}

function describeStatus(status: number, body: string): string {
  const detail = extractMessage(body);
  const prefix =
    status === 401 || status === 403
      ? 'the provider rejected the API key'
      : status === 404
        ? 'the provider does not know that model or endpoint'
        : status === 429
          ? 'the provider is rate-limiting this key'
          : `the provider returned ${status}`;
  return detail ? `${prefix}: ${detail}` : prefix;
}

function extractMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string') return error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Not JSON. The raw text is still better than nothing, trimmed so an HTML
    // error page does not become the whole toast.
  }
  return body.trim().slice(0, 200);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
