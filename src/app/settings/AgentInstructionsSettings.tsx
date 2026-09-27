/**
 * The agent's standing instructions (plan §3.2, item 4): conventions the
 * student would otherwise repeat in every request. Saved when the field loses
 * focus, so typing is not a stream of settings writes.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_AGENT_INSTRUCTIONS, useSettingsStore } from '@/lib/state/settingsStore';

export function AgentInstructionsSettings() {
  const { t } = useTranslation();
  const saved = useSettingsStore((state) => state.settings.agentInstructions);
  const update = useSettingsStore((state) => state.update);
  const [draft, setDraft] = useState(saved);

  useEffect(() => setDraft(saved), [saved]);

  return (
    <section className="flex flex-col gap-1.5">
      <label htmlFor="nb-agent-instructions" className="text-[13px] font-semibold">
        {t('agent.instructions.title')}
      </label>
      <p className="text-[11px] leading-snug text-nb-text-3">
        {t('agent.instructions.hint')}
      </p>
      <textarea
        id="nb-agent-instructions"
        rows={5}
        value={draft}
        maxLength={MAX_AGENT_INSTRUCTIONS}
        placeholder={t('agent.instructions.placeholder')}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== saved) void update({ agentInstructions: draft });
        }}
        className="w-full resize-y rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-control-surface)] px-2.5 py-2 text-[12.5px] leading-relaxed text-nb-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]"
      />
      <p className="text-right text-[10.5px] text-nb-text-3">
        {t('agent.instructions.count', {
          count: draft.length,
          max: MAX_AGENT_INSTRUCTIONS,
        })}
      </p>
    </section>
  );
}
