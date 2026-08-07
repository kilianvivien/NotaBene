/**
 * Local model detection.
 *
 * Two things here are load-bearing. One is that "local" means the bytes stay on
 * the machine, which is a fact about the address and not about which row of the
 * provider table we are on — get that wrong and the green badge is a lie about
 * privacy. The other is that a runtime's own answer beats our baked-in default,
 * because our default is a guess and the runtime is telling us.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiTransport, DEFAULT_SETTINGS, type AppSettings } from '@/lib/adapters';
import { detectLocalModels, isLoopbackUrl, supportsModelDetection } from './localModels';
import { providerById } from './providers';
import { modelsFor, resolveFeature } from './resolve';

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

/** Answer some routes and 404 the rest, the way a real runtime does when it is
 * a version older than the endpoint we asked for. */
function serve(routes: Record<string, unknown>) {
  return vi.spyOn(aiTransport, 'request').mockImplementation(async (request) => {
    const path = new URL(request.url).pathname;
    return Object.prototype.hasOwnProperty.call(routes, path)
      ? { status: 200, headers: {}, body: JSON.stringify(routes[path]) }
      : { status: 404, headers: {}, body: 'not found' };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isLoopbackUrl', () => {
  it('recognises every way of spelling this machine', () => {
    for (const url of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:11434/v1',
      'http://127.1.2.3:8080',
      'http://[::1]:1234/v1',
      'http://ollama.localhost/v1',
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  it('does not call a remote box local because the provider is named Ollama', () => {
    // The badge is a privacy claim, and an Ollama on the lab's GPU server is a
    // network hop like any other.
    for (const url of [
      'http://gpu-box.lan:11434/v1',
      'https://api.openai.com/v1',
      'http://10.0.0.4:1234/v1',
      'not a url',
      '',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });
});

describe('detectLocalModels', () => {
  const lmstudio = providerById('lmstudio')!;
  const ollama = providerById('ollama')!;

  it('reads LM Studio’s loaded model out of its own listing', async () => {
    serve({
      '/api/v0/models': {
        object: 'list',
        data: [
          { id: 'qwen3-8b-mlx', state: 'loaded' },
          { id: 'gemma-3-12b', state: 'not-loaded' },
        ],
      },
    });

    await expect(
      detectLocalModels(lmstudio, 'http://localhost:1234/v1'),
    ).resolves.toEqual({
      loaded: ['qwen3-8b-mlx'],
      available: ['qwen3-8b-mlx', 'gemma-3-12b'],
    });
  });

  it('asks the origin, not the chat base URL', async () => {
    const spy = serve({});
    await detectLocalModels(ollama, 'http://localhost:11434/v1');
    const asked = spy.mock.calls.map(([request]) => request.url);
    // `/api/ps` hangs off the origin; `/models` off the base URL. Both, in that
    // order, and neither at `/v1/api/ps`.
    expect(asked).toEqual([
      'http://localhost:11434/api/ps',
      'http://localhost:11434/v1/models',
    ]);
  });

  it('combines what Ollama is running with what it could run', async () => {
    serve({
      '/api/ps': { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] },
      '/v1/models': { data: [{ id: 'qwen3:8b' }, { id: 'llama3.2:latest' }] },
    });

    await expect(
      detectLocalModels(ollama, 'http://localhost:11434/v1'),
    ).resolves.toEqual({
      loaded: ['qwen3:8b'],
      available: ['qwen3:8b', 'llama3.2:latest'],
    });
  });

  it('falls back to the OpenAI listing when the native route is missing', async () => {
    // An LM Studio too old for `/api/v0`. Losing the loaded/idle distinction is
    // a downgrade; losing the model list entirely would be a regression.
    serve({ '/v1/models': { data: [{ id: 'phi-4' }] } });

    await expect(
      detectLocalModels(lmstudio, 'http://localhost:1234/v1'),
    ).resolves.toEqual({ loaded: [], available: ['phi-4'] });
  });

  it('is silent when nothing is listening', async () => {
    vi.spyOn(aiTransport, 'request').mockRejectedValue(new Error('connection refused'));

    await expect(
      detectLocalModels(lmstudio, 'http://localhost:1234/v1'),
    ).resolves.toEqual({ loaded: [], available: [] });
  });

  it('does not guess at routes on an endpoint we know nothing about', () => {
    // A custom base URL may be a university gateway. Probing it for LM Studio's
    // private API is a stray request, not a feature.
    expect(supportsModelDetection(providerById('custom')!)).toBe(false);
    expect(supportsModelDetection(providerById('openai')!)).toBe(false);
    expect(supportsModelDetection(lmstudio)).toBe(true);
  });
});

describe('resolution with a detected model', () => {
  const lmstudioOn = settingsWith({
    aiProviders: { lmstudio: { enabled: true, baseUrl: null, extraModels: [] } },
  });

  it('gives LM Studio a model it never had a default for', () => {
    // Without detection this is the `no_model` dead end the user has to type
    // their way out of: LM Studio ships with an empty catalogue.
    expect(resolveFeature('rewrite', lmstudioOn, [])).toEqual({
      available: false,
      reason: 'no_model',
    });

    const result = resolveFeature('rewrite', lmstudioOn, [], {
      lmstudio: { loaded: ['qwen3-8b-mlx'], available: ['qwen3-8b-mlx', 'gemma-3-12b'] },
    });
    if (!result.available) throw new Error('expected LM Studio to resolve');
    expect(result.model).toBe('qwen3-8b-mlx');
  });

  it('prefers what is loaded over the default in our table', () => {
    const ollamaOn = settingsWith({
      aiProviders: { ollama: { enabled: true, baseUrl: null, extraModels: [] } },
    });
    expect(resolveFeature('rewrite', ollamaOn, [])).toMatchObject({
      model: 'llama3.2',
    });

    const result = resolveFeature('rewrite', ollamaOn, [], {
      ollama: { loaded: ['qwen3:8b'], available: ['qwen3:8b', 'llama3.2'] },
    });
    expect(result).toMatchObject({ model: 'qwen3:8b' });
  });

  it('never overrides a model the user typed', () => {
    const chosen = settingsWith({
      aiProviders: { ollama: { enabled: true, baseUrl: null, extraModels: [] } },
      aiFeatureModels: { rewrite: { providerId: 'ollama', model: 'mistral' } },
    });
    const result = resolveFeature('rewrite', chosen, [], {
      ollama: { loaded: ['qwen3:8b'], available: ['qwen3:8b'] },
    });
    expect(result).toMatchObject({ model: 'mistral' });
  });

  it('puts detected models at the front of the picker', () => {
    const suggestions = modelsFor(providerById('ollama')!, lmstudioOn, {
      ollama: { loaded: ['qwen3:8b'], available: ['qwen3:8b', 'phi4'] },
    });
    expect(suggestions.slice(0, 2)).toEqual(['qwen3:8b', 'phi4']);
    expect(suggestions).toContain('llama3.2');
  });
});
