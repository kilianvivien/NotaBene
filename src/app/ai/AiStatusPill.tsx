/**
 * Which provider and model an action will use, shown *before* it runs.
 *
 * The plan calls this the cost-surprise mitigation and it is, but the bigger
 * job is trust: a student who can see "Mistral · mistral-medium-latest" on the
 * button knows exactly where their lecture notes are about to go. When nothing
 * is configured the pill becomes the way in — it says so, and clicking it opens
 * the provider settings rather than leaving a dead disabled control.
 */
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiFeature } from '@/lib/ai';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { useAiAvailability } from './useAiAvailability';

export function AiStatusPill({
  feature,
  className,
}: {
  feature: AiFeature;
  className?: string;
}) {
  const { t } = useTranslation();
  const availability = useAiAvailability(feature);
  const setSettingsTab = useUiStore((state) => state.setSettingsTab);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  function openProviders() {
    setSettingsTab('aiProviders');
    setSettingsOpen(true);
  }

  return (
    <button
      type="button"
      onClick={openProviders}
      title={t('ai.pillHint')}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
        'transition-colors duration-[var(--nb-t-fast)]',
        availability.available
          ? 'bg-[var(--nb-hover)] text-nb-text-3 hover:text-nb-text-2'
          : 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]',
        className,
      )}
    >
      <Sparkles size={10} className="shrink-0" aria-hidden />
      <span className="truncate">
        {availability.available
          ? `${availability.definition.label} · ${availability.model}`
          : t(`ai.unavailable_${availability.reason}`)}
      </span>
    </button>
  );
}
