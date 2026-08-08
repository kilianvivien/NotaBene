/**
 * The provider catalogue.
 *
 * Three wire protocols cover every provider worth shipping: Anthropic's
 * Messages API, the OpenAI chat-completions shape that most of the industry
 * cloned, and Gemini's. So a "provider" here is mostly a base URL, an auth
 * header, and a handful of quirks — which is why adding Mistral, or a
 * self-hosted vLLM box, is an entry in a table rather than a new module.
 *
 * Model lists are *suggestions*. They go into a datalist, never a closed
 * select: a catalogue baked into a desktop app is stale the week after it
 * ships, and a student who wants a model released yesterday should be able to
 * type its id rather than wait for us. `defaultModel` is only what a freshly
 * configured provider starts on.
 */
export type AiProtocol = 'anthropic' | 'openai' | 'gemini';

export interface ProviderDefinition {
  id: string;
  label: string;
  protocol: AiProtocol;
  /** Includes the version segment, so a custom endpoint can point anywhere. */
  defaultBaseUrl: string;
  /** Local runtimes authenticate by being on loopback and nothing else. */
  requiresKey: boolean;
  /** Whether Settings lets the user rewrite the base URL. */
  editableBaseUrl: boolean;
  models: string[];
  defaultModel: string;
  /** Where to go and get a key. Opened in the system browser, never in-app. */
  keyUrl?: string;
  quirks?: ProviderQuirks;
}

export interface ProviderQuirks {
  /** OpenAI renamed the field and rejects the old one on newer models. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Newer reasoning models accept only their default sampling behavior, and
   * may answer a request that sets a temperature with a 400. */
  sendTemperature?: boolean;
  /** Not every OpenAI-compatible server implements `response_format`; asking
   * an Ollama build that does not for one is a hard error, not a downgrade.
   * LM Studio is the sharper case: it implements the field but accepts only
   * `json_schema` and `text`, and answers `json_object` with a 400. */
  jsonMode?: boolean;
}

export const AI_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    editableBaseUrl: false,
    models: [
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ],
    defaultModel: 'claude-sonnet-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    quirks: { sendTemperature: false },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    editableBaseUrl: false,
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6'],
    defaultModel: 'gpt-5.6-terra',
    keyUrl: 'https://platform.openai.com/api-keys',
    quirks: { maxTokensField: 'max_completion_tokens', sendTemperature: false },
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    editableBaseUrl: false,
    // The `-latest` aliases on purpose: they keep pointing at the current
    // generation, which is the right default for a list we cannot update
    // between releases.
    models: [
      'mistral-large-latest',
      'mistral-large-2512',
      'mistral-medium-latest',
      'mistral-medium-3-5',
      'mistral-small-latest',
      'mistral-small-2603',
    ],
    defaultModel: 'mistral-medium-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    editableBaseUrl: false,
    models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    defaultModel: 'gemini-3.6-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    quirks: { sendTemperature: false },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    editableBaseUrl: false,
    models: [
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'mistralai/mistral-medium-3-5',
      'google/gemini-3.6-flash',
      'google/gemini-3.5-flash-lite',
    ],
    defaultModel: 'anthropic/claude-sonnet-5',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    editableBaseUrl: true,
    models: ['llama3.2', 'qwen2.5', 'mistral', 'gemma3'],
    defaultModel: 'llama3.2',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    protocol: 'openai',
    defaultBaseUrl: 'http://localhost:1234/v1',
    requiresKey: false,
    editableBaseUrl: true,
    models: [],
    defaultModel: '',
    // LM Studio validates `response_format.type` against `json_schema` and
    // `text`, so the `json_object` every other OpenAI-compatible server takes
    // is a 400 here — and it took down rewrite, synthesis, flashcards, mind
    // maps and podcasts while Ask, which asks for prose, kept working. Its own
    // structured mode wants a JSON Schema per call, which we do not have; the
    // prompts already say "a single JSON object and nothing else", and the
    // answer is parsed and validated either way.
    quirks: { jsonMode: false },
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible',
    protocol: 'openai',
    defaultBaseUrl: '',
    requiresKey: true,
    editableBaseUrl: true,
    models: [],
    defaultModel: '',
  },
];

const BY_ID = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]));

export function providerById(id: string): ProviderDefinition | undefined {
  return BY_ID.get(id);
}

/** The Keychain account name a provider's key is stored under. Prefixed so a
 * future non-AI secret cannot collide with a provider id. */
export function secretKeyFor(providerId: string): string {
  return `ai.${providerId}.apiKey`;
}

/** The features that pick their own model. `default` is the fallback every
 * other feature resolves through, so a user who configures one provider gets a
 * working app without visiting a matrix. */
export const AI_FEATURES = [
  'default',
  'rewrite',
  'synthesis',
  'ask',
  'mindMap',
  'flashcards',
  'podcast',
  'importFormat',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
