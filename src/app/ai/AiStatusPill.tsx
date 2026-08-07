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
  modelOnly = false,
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
  /**
   * The model's name instead of the sparkle, for panes that already spend a
   * sparkle on something else.
   *
   * The Ask panel had three of them meaning three different things, and this is
   * the one whose value is a word rather than a state — a model name is legible
   * at 11px where a glyph is only a reminder that AI is involved, which the
   * panel says everywhere else. The provider still rides in the tooltip.
   */
  modelOnly?: boolean;
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

  // The glyph is only ever a shorthand for a configured provider — unconfigured,
  // the pill is the way in and has to say so in words.
  const glyphOnly = compact && !modelOnly && availability.available;
  const named = modelOnly && availability.available;

  return (
    <button
      type="button"
      onClick={openProviders}
      // The model name reads as a caption, so it says the provider — the half
      // it drops — in the label a screen reader gets, exactly as the glyph does.
      aria-label={glyphOnly || named ? `${full} — ${t('ai.pillHint')}` : undefined}
      title={availability.available ? `${full} — ${t('ai.pillHint')}` : t('ai.pillHint')}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full',
        'transition-colors duration-[var(--nb-t-fast)]',
        // A caption under the composer rather than a control: small enough that
        // the send button beside it is plainly the thing you press. It stays
        // small when there is no provider yet — it is still only a line of
        // text, and the accent is what makes it findable. The dialogs' header
        // pill keeps its own size.
        modelOnly ? 'px-1 py-0 text-[10px]' : 'text-[11px]',
        glyphOnly ? 'size-6 justify-center' : modelOnly ? undefined : 'px-2 py-0.5',
        !availability.available
          ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
          : glyphOnly || named
            ? 'text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text-2'
            : 'bg-[var(--nb-hover)] text-nb-text-3 hover:text-nb-text-2',
        className,
      )}
    >
      {!named && (
        <Sparkles
          size={glyphOnly ? 12 : modelOnly ? 9 : 10}
          className="shrink-0"
          aria-hidden
        />
      )}
      {!glyphOnly && (
        <span className="truncate">{named ? availability.model : full}</span>
      )}
    </button>
  );
}
