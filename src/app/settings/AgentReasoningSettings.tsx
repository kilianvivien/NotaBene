/**
 * How hard the in-app agent thinks. Three choices rather than the provider's
 * own levels, because those differ by model — GLM has no `none`, Large 4 has
 * nothing between `none` and `high` — and `reasoningEffortFor` translates.
 * Where the agent's model picks its own level, the line under the cards says
 * so rather than offering a choice that would be ignored silently.
 */
import { Brain, Gauge, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChoiceGroup } from '@/components/glass';
import { modelDisplayName } from '@/lib/ai';
import { reasoningEffortFor, type AgentReasoning } from '@/lib/ai/budgets';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useAiAvailability } from '@/app/ai/useAiAvailability';

export function AgentReasoningSettings() {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.settings.agentReasoning);
  const update = useSettingsStore((state) => state.update);
  const availability = useAiAvailability('agent');
  const model = availability.available
    ? modelDisplayName(availability.definition, availability.model)
    : null;
  const controllable =
    availability.available &&
    reasoningEffortFor(
      {
        definition: availability.definition,
        baseUrl: availability.baseUrl,
        apiKey: null,
        model: availability.model,
      },
      'thorough',
    ) !== undefined;

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold">{t('agent.reasoning.title')}</h3>
      <p className="text-[11px] leading-snug text-nb-text-3">
        {t('agent.reasoning.hint')}
      </p>
      <ChoiceGroup<AgentReasoning>
        label={t('agent.reasoning.title')}
        value={value}
        onChange={(next) => void update({ agentReasoning: next })}
        columns={3}
        options={[
          {
            value: 'auto',
            icon: Gauge,
            title: t('agent.reasoning.auto'),
            description: t('agent.reasoning.autoHint'),
          },
          {
            value: 'light',
            icon: Zap,
            title: t('agent.reasoning.light'),
            description: t('agent.reasoning.lightHint'),
          },
          {
            value: 'thorough',
            icon: Brain,
            title: t('agent.reasoning.thorough'),
            description: t('agent.reasoning.thoroughHint'),
          },
        ]}
      />
      {model && (
        <p className="text-[10.5px] leading-snug text-nb-text-3">
          {t(controllable ? 'agent.reasoning.applies' : 'agent.reasoning.modelDecides', {
            model,
          })}
        </p>
      )}
    </section>
  );
}
