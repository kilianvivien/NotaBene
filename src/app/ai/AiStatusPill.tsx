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
  compact = false,
  className,
}: {
  feature: AiFeature;
  /**
   * Say it with a glyph once there is nothing to do about it.
   *
   * A configured provider is a detail you check, not a thing you act on, so in
   * a pane too narrow to hold "Mistral · mistral-medium-latest" it becomes the
   * sparkle alone with the full line in its tooltip. Unconfigured it stays
   * spelled out and accented, because then it is the only way in and a glyph
   * would be a puzzle in place of an instruction.
   */
  compact?: boolean;
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

  const full = availability.available
    ? `${availability.definition.label} · ${availability.model}`
    : t(`ai.unavailable_${availability.reason}`);

  const glyphOnly = compact && availability.available;

  return (
    <button
      type="button"
      onClick={openProviders}
      aria-label={glyphOnly ? `${full} — ${t('ai.pillHint')}` : undefined}
      title={availability.available ? `${full} — ${t('ai.pillHint')}` : t('ai.pillHint')}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full text-[11px]',
        'transition-colors duration-[var(--nb-t-fast)]',
        glyphOnly ? 'size-6 justify-center' : 'px-2 py-0.5',
        !availability.available
          ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
          : glyphOnly
            ? 'text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text-2'
            : 'bg-[var(--nb-hover)] text-nb-text-3 hover:text-nb-text-2',
        className,
      )}
    >
      <Sparkles size={glyphOnly ? 12 : 10} className="shrink-0" aria-hidden />
      {!glyphOnly && <span className="truncate">{full}</span>}
    </button>
  );
}
