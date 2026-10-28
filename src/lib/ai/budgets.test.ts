import { describe, expect, it } from 'vitest';
import { migrateSettings } from '@/lib/state/settingsStore';
import { reasoningEffortFor, structuredReasoningEffort } from './budgets';
import type { ResolvedProvider } from './protocols';
import { providerById } from './providers';

function on(providerId: string, model: string): ResolvedProvider {
  const definition = providerById(providerId)!;
  return { definition, baseUrl: definition.defaultBaseUrl, apiKey: 'k', model };
}

describe('agent reasoning', () => {
  // Each pair is what that model's endpoint accepted when probed; anything
  // else is a 400 rather than a downgrade.
  it.each([
    ['zai-glm-5-3', 'low', 'low', 'high'],
    ['zai-glm-5-3-flash', 'low', 'low', 'high'],
    ['deepseek-v4-1-flash-1017', 'low', 'none', 'high'],
    ['mistral-large-4', 'none', 'none', 'high'],
  ])('sends %s only levels it accepts', (model, auto, light, thorough) => {
    const provider = on('mistral', model);
    expect(reasoningEffortFor(provider, 'auto')).toBe(auto);
    expect(reasoningEffortFor(provider, 'light')).toBe(light);
    expect(reasoningEffortFor(provider, 'thorough')).toBe(thorough);
    expect(structuredReasoningEffort(provider)).toBe(auto);
  });

  it('leaves every other model to decide for itself', () => {
    expect(
      reasoningEffortFor(on('mistral', 'some-new-model'), 'thorough'),
    ).toBeUndefined();
    expect(
      reasoningEffortFor(on('anthropic', 'claude-sonnet-5'), 'thorough'),
    ).toBeUndefined();
  });

  it('keeps a stored choice and repairs a hand-edited one', () => {
    expect(migrateSettings({ agentReasoning: 'thorough' }).agentReasoning).toBe(
      'thorough',
    );
    expect(migrateSettings({}).agentReasoning).toBe('auto');
    // Review defaults to larger tasks only; only an explicit "always" sticks.
    expect(migrateSettings({}).agentReview).toBe('large');
    expect(migrateSettings({ agentReview: 'always' }).agentReview).toBe('always');
    expect(migrateSettings({ agentReview: 'never' as never }).agentReview).toBe('large');
    expect(migrateSettings({ agentReasoning: 'max' as never }).agentReasoning).toBe(
      'auto',
    );
  });
});
