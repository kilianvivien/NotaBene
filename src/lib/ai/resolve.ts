/**
 * Which provider and model a feature will actually use — answered *before* it
 * runs, so the status pill can say so and the button can be honest about being
 * disabled.
 *
 * Resolution is deliberately three-legged. A feature may name its own
 * provider/model pair; failing that it falls through to the `default` pair;
 * failing that, to the only provider that has a key. The last leg is what makes
 * "paste one key, everything works" true without a settings matrix.
 */
import { secrets } from '@/lib/adapters';
import type { AppSettings } from '@/lib/adapters';
import type { ResolvedProvider } from './protocols';
import {
  AI_PROVIDERS,
  providerById,
  secretKeyFor,
  type AiFeature,
  type ProviderDefinition,
} from './providers';

/** Why a feature cannot run. Each maps to one sentence in the UI — never to a
 * disabled button with no explanation. */
export type AiUnavailableReason = 'no_provider' | 'no_model' | 'no_base_url';

export type AiAvailability =
  | {
      available: true;
      definition: ProviderDefinition;
      baseUrl: string;
      model: string;
    }
  | { available: false; reason: AiUnavailableReason };

/** Provider ids with a key on file. `SecretsAdapter.listKeys` returns names
 * only, so this never pulls a secret into the webview. */
export async function configuredProviderIds(): Promise<string[]> {
  const keys = await secrets.listKeys();
  return AI_PROVIDERS.filter((provider) => keys.includes(secretKeyFor(provider.id))).map(
    (provider) => provider.id,
  );
}

/**
 * A provider is usable when the user has opted into it and it knows where to
 * connect. Opting in is pasting a key, or — for a local runtime, which has no
 * key to paste — switching it on. Without that second gesture the app would
 * quietly resolve to an Ollama nobody installed rather than saying "connect a
 * provider", and the first AI action a new user tried would fail with a
 * connection error instead of an explanation.
 */
export function isProviderUsable(
  definition: ProviderDefinition,
  settings: AppSettings,
  keyedProviderIds: string[],
): boolean {
  if (!baseUrlFor(definition, settings)) return false;
  return definition.requiresKey
    ? keyedProviderIds.includes(definition.id)
    : settings.aiProviders[definition.id]?.enabled === true;
}

export function baseUrlFor(
  definition: ProviderDefinition,
  settings: AppSettings,
): string {
  const configured = settings.aiProviders[definition.id]?.baseUrl?.trim();
  return configured || definition.defaultBaseUrl;
}

/** Every model the picker should offer for a provider: the catalogue, plus
 * whatever the user has typed in before. */
export function modelsFor(
  definition: ProviderDefinition,
  settings: AppSettings,
): string[] {
  const extra = settings.aiProviders[definition.id]?.extraModels ?? [];
  return [...new Set([...definition.models, ...extra])];
}

export function resolveFeature(
  feature: AiFeature,
  settings: AppSettings,
  keyedProviderIds: string[],
): AiAvailability {
  const choice = settings.aiFeatureModels[feature] ?? settings.aiFeatureModels.default;
  const chosen = choice ? providerById(choice.providerId) : undefined;

  const definition =
    chosen && isProviderUsable(chosen, settings, keyedProviderIds)
      ? chosen
      : AI_PROVIDERS.find((provider) =>
          isProviderUsable(provider, settings, keyedProviderIds),
        );

  if (!definition) {
    // Distinguish "nothing is set up" from "the one thing you set up has no
    // address": the second is a typo the user can fix in ten seconds, and
    // saying "connect a provider" instead would send them the wrong way.
    const keyedButAddressless = AI_PROVIDERS.some(
      (provider) =>
        (keyedProviderIds.includes(provider.id) || !provider.requiresKey) &&
        !baseUrlFor(provider, settings),
    );
    return { available: false, reason: keyedButAddressless ? 'no_base_url' : 'no_provider' };
  }

  // The stored model only applies when it belongs to the provider we landed on;
  // falling back past a provider must not carry its model along.
  const model =
    (choice?.providerId === definition.id ? choice.model : undefined)?.trim() ||
    (settings.aiFeatureModels.default?.providerId === definition.id
      ? settings.aiFeatureModels.default.model
      : undefined
    )?.trim() ||
    definition.defaultModel ||
    modelsFor(definition, settings)[0] ||
    '';

  if (!model) return { available: false, reason: 'no_model' };
  return {
    available: true,
    definition,
    baseUrl: baseUrlFor(definition, settings),
    model,
  };
}

/** Turn an availability into something callable, fetching the key at the last
 * possible moment. The key is held for the duration of one call and never
 * stored in a component, a store, or a log line. */
export async function loadProvider(
  availability: Extract<AiAvailability, { available: true }>,
): Promise<ResolvedProvider> {
  const apiKey = availability.definition.requiresKey
    ? await secrets.get(secretKeyFor(availability.definition.id))
    : null;

  if (availability.definition.requiresKey && !apiKey) {
    throw new Error(`no API key stored for ${availability.definition.label}`);
  }

  return {
    definition: availability.definition,
    baseUrl: availability.baseUrl,
    apiKey,
    model: availability.model,
  };
}
