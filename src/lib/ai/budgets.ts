import type { AiCall, ResolvedProvider } from './protocols';

/** Reasoning and the visible answer share the provider's output allowance.
 * Keep room for both, even when the requested answer itself is short. The
 * client still clamps output to the space left in a small context window. */
export const DEFAULT_OUTPUT_TOKENS = 8_192;
export const VISUALIZATION_OUTPUT_TOKENS = 16_384;

/** How hard the agent should think, as the student chooses it in Settings.
 * Translated per model, because no two models accept the same levels. */
export const AGENT_REASONING_LEVELS = ['auto', 'light', 'thorough'] as const;
export type AgentReasoning = (typeof AGENT_REASONING_LEVELS)[number];

type Effort = NonNullable<AiCall['reasoningEffort']>;

/**
 * The levels each hosted model accepts — an unsupported one is a 400, not a
 * downgrade. Initially probed against `/v1/responses` on 2026-10-28; Large 4's
 * preview `none` became `low` (confirmed in Mistral's reasoning docs and a
 * chat-completions 400 on 2026-10-30). `auto` is what the structured features
 * send unasked; `light` is the least the model allows, `thorough` the most
 * worth paying for. https://docs.mistral.ai/studio/conversations/reasoning
 */
const MISTRAL_REASONING: Record<string, Record<AgentReasoning, Effort>> = {
  'zai-glm-5-3': { auto: 'low', light: 'low', thorough: 'high' },
  'zai-glm-5-3-flash': { auto: 'low', light: 'low', thorough: 'high' },
  'deepseek-v4-1-flash-1017': { auto: 'low', light: 'none', thorough: 'high' },
  'mistral-large-4': { auto: 'low', light: 'low', thorough: 'high' },
  'mistral-large-4-0': { auto: 'low', light: 'low', thorough: 'high' },
  ...Object.fromEntries(
    ['mistral-medium-3-5', 'mistral-small-latest', 'mistral-small-2603'].map((model) => [
      model,
      { auto: 'none', light: 'none', thorough: 'high' } as const,
    ]),
  ),
};

/** Only send levels already supported by these specific hosted models. */
export function structuredReasoningEffort(
  provider: ResolvedProvider,
): AiCall['reasoningEffort'] {
  return reasoningEffortFor(provider, 'auto');
}

/** The level to send for a reasoning choice, or `undefined` where the model
 * picks its own — every provider but Mistral, and any model not in the table. */
export function reasoningEffortFor(
  provider: ResolvedProvider,
  choice: AgentReasoning,
): AiCall['reasoningEffort'] {
  if (provider.definition?.id !== 'mistral') return undefined;
  return MISTRAL_REASONING[provider.model]?.[choice];
}

/** Conservative input estimate for one bounded vision image. */
export const IMAGE_INPUT_TOKENS = 4_096;
