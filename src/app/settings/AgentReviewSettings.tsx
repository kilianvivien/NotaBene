/**
 * When the student sees the agent's plan before it runs. The default reviews
 * only larger or riskier tasks (`planNeedsReview`); a student who wants to see
 * every plan can say so. Follow-ups never wait either way — they continue a
 * task already seen.
 */
import { ListChecks, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChoiceGroup } from '@/components/glass';
import type { AppSettings } from '@/lib/adapters';
import { useSettingsStore } from '@/lib/state/settingsStore';

export function AgentReviewSettings() {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.settings.agentReview);
  const update = useSettingsStore((state) => state.update);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold">{t('agent.review.title')}</h3>
      <p className="text-[11px] leading-snug text-nb-text-3">{t('agent.review.hint')}</p>
      <ChoiceGroup<AppSettings['agentReview']>
        label={t('agent.review.title')}
        value={value}
        onChange={(next) => void update({ agentReview: next })}
        options={[
          {
            value: 'large',
            icon: Zap,
            title: t('agent.review.large'),
            description: t('agent.review.largeHint'),
          },
          {
            value: 'always',
            icon: ListChecks,
            title: t('agent.review.always'),
            description: t('agent.review.alwaysHint'),
          },
        ]}
      />
    </section>
  );
}
