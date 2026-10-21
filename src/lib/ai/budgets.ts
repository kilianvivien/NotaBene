import type { AiCall, ResolvedProvider } from './protocols';

/** Reasoning and the visible answer share the provider's output allowance.
 * Keep room for both, even when the requested answer itself is short. The
 * client still clamps output to the space left in a small context window. */
export const DEFAULT_OUTPUT_TOKENS = 8_192;
export const VISUALIZATION_OUTPUT_TOKENS = 16_384;

/** Only send levels already supported by these specific hosted models. */
export function structuredReasoningEffort(
  provider: ResolvedProvider,
): AiCall['reasoningEffort'] {
  const { definition, model } = provider;
  if (definition?.id !== 'mistral') return undefined;
  if (model === 'zai-glm-5-3') return 'low';
  return [
    'mistral-large-4',
    'mistral-large-4-0',
    'mistral-medium-3-5',
    'mistral-small-latest',
    'mistral-small-2603',
  ].includes(model)
    ? 'none'
    : undefined;
}
