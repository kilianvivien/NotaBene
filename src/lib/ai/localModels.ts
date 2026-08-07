/**
 * Asking a local runtime what it is running.
 *
 * A cloud provider has a catalogue we can ship in a table. A local one does
 * not: what LM Studio will answer with is whichever model the student loaded
 * this morning, and typing its exact id into Settings — `qwen3-8b-mlx@4bit`,
 * hyphens and all — is a chore with a typo in it. So we ask. Both runtimes
 * expose a listing on loopback, and both are free to answer, which is the whole
 * argument for doing this automatically rather than behind a Detect button.
 *
 * Two facts make the endpoints different from the chat one:
 *
 * - They are *origin*-relative, not base-URL-relative. `http://localhost:1234/v1`
 *   is where chat completions live; `/api/v0/models` hangs off the origin.
 * - Only the native listings distinguish loaded from merely downloaded. That
 *   distinction is the point: sending a prompt to a downloaded-but-cold model
 *   makes LM Studio load it, which on a laptop means a thirty-second stall the
 *   student did not ask for.
 *
 * Failure is silence. A local runtime that is not running is the normal state
 * of a machine, not an error to report, so every probe collapses to "nothing
 * detected" and the app carries on saying "connect a provider".
 */
import { aiTransport } from '@/lib/adapters';
import {
  LmStudioModelListSchema,
  OllamaRunningModelsSchema,
  OpenAiModelListSchema,
} from '@/lib/schema';
import type { ProviderDefinition } from './providers';

export interface LocalModels {
  /** In memory right now, and therefore free to answer. Empty when the runtime
   * is up but idle — which is a real state, not a failure. */
  loaded: string[];
  /** Everything it could load, for the picker's suggestion list. */
  available: string[];
}

export const NO_LOCAL_MODELS: LocalModels = { loaded: [], available: [] };

/** A probe is a health check on a socket next door; it should not take longer
 * than a click feels. A runtime that has not answered by now is one the user
 * would rather hear nothing about. */
const PROBE_TIMEOUT_MS = 2_500;

/**
 * Whether traffic to this address stays on the machine.
 *
 * Keyed on the resolved host rather than the provider id, because both local
 * providers have an editable base URL: an Ollama pointed at the lab's GPU box
 * is not private, and a `custom` endpoint pointed at `127.0.0.1` is. The
 * "local" badge is a privacy claim, so it has to track where the bytes actually
 * go.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL keeps IPv6 literals in their brackets.
  const bare = host.replace(/^\[|\]$/g, '');
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  );
}

/** Providers whose listing we know how to read. `custom` is deliberately not
 * here: it may be a vLLM box or a university gateway, and guessing at LM
 * Studio's routes on someone else's server is a stray request, not a feature. */
export function supportsModelDetection(definition: ProviderDefinition): boolean {
  return definition.id === 'lmstudio' || definition.id === 'ollama';
}

/**
 * What this runtime has loaded, and what else it could load.
 *
 * The native listing runs first because it is the only one that answers the
 * loaded question; `/models` follows as the fallback that any OpenAI-compatible
 * server — including a version of either runtime older than the route we ask
 * for — will still answer.
 */
export async function detectLocalModels(
  definition: ProviderDefinition,
  baseUrl: string,
): Promise<LocalModels> {
  if (!baseUrl) return NO_LOCAL_MODELS;

  const native =
    definition.id === 'lmstudio'
      ? await lmStudioModels(baseUrl)
      : definition.id === 'ollama'
        ? await ollamaRunningModels(baseUrl)
        : NO_LOCAL_MODELS;

  if (native.available.length) return native;

  const available = await openAiModels(baseUrl);
  return { loaded: native.loaded, available };
}

async function lmStudioModels(baseUrl: string): Promise<LocalModels> {
  const parsed = LmStudioModelListSchema.safeParse(
    await getJson(originOf(baseUrl, '/api/v0/models')),
  );
  if (!parsed.success) return NO_LOCAL_MODELS;
  return {
    loaded: parsed.data.data
      .filter((model) => model.state === 'loaded')
      .map((model) => model.id),
    available: parsed.data.data.map((model) => model.id),
  };
}

async function ollamaRunningModels(baseUrl: string): Promise<LocalModels> {
  const parsed = OllamaRunningModelsSchema.safeParse(
    await getJson(originOf(baseUrl, '/api/ps')),
  );
  if (!parsed.success) return NO_LOCAL_MODELS;
  const loaded = parsed.data.models
    .map((model) => model.model ?? model.name ?? '')
    .filter(Boolean);
  // `/api/ps` lists only what is resident, so it can never stand in for the
  // catalogue — the fallback still runs and fills `available`.
  return { loaded, available: [] };
}

async function openAiModels(baseUrl: string): Promise<string[]> {
  const parsed = OpenAiModelListSchema.safeParse(
    await getJson(`${baseUrl.replace(/\/+$/, '')}/models`),
  );
  return parsed.success ? parsed.data.data.map((model) => model.id) : [];
}

/** `http://localhost:1234/v1` → `http://localhost:1234/api/ps`. */
function originOf(baseUrl: string, path: string): string {
  try {
    return new URL(path, new URL(baseUrl).origin).toString();
  } catch {
    return '';
  }
}

/** A GET that never throws. Every caller wants "or nothing" rather than a
 * rejection to catch, because there is no version of this failing that the user
 * needs to hear about. */
async function getJson(url: string): Promise<unknown> {
  if (!url) return null;
  try {
    const response = await withTimeout(
      aiTransport.request({
        url,
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
    );
    if (!response || response.status >= 400) return null;
    return JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
}

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    }),
  ]);
}
