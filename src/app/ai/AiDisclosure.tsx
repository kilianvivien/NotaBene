/**
 * The way from a model's name to what using it means.
 *
 * The EU AI Act asks that someone using an AI system be told they are, and in
 * terms they can act on. NotaBene's answer lives in About — that a model can be
 * wrong, that the note's history records what it wrote, that the text goes to
 * the provider you configured and nowhere else — and this is the "i" that opens
 * it, sitting beside every place a model name appears. The notice is one page
 * rather than a paragraph repeated in six dialogs, because a disclosure copied
 * six times is a disclosure that ends up saying six slightly different things.
 */
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { AiStatusPill } from './AiStatusPill';
import type { AiFeature } from '@/lib/ai';

export function AiDisclosureButton({
  onLeave,
  className,
}: {
  /** A modal caller's own close — see `AiStatusPill`'s `onLeave`. Settings
   * opening behind a dialog is a window nobody can reach. */
  onLeave?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const setSettingsTab = useUiStore((state) => state.setSettingsTab);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  return (
    <button
      type="button"
      aria-label={t('ai.disclosure')}
      title={t('ai.disclosure')}
      onClick={() => {
        onLeave?.();
        setSettingsTab('about');
        setSettingsOpen(true);
      }}
      className={cn(
        'grid size-[18px] shrink-0 place-items-center rounded-full text-nb-text-3',
        'transition-colors duration-[var(--nb-t-fast)]',
        'hover:bg-[var(--nb-hover)] hover:text-nb-text-2',
        className,
      )}
    >
      <Info size={12} aria-hidden />
    </button>
  );
}

/** What a dialog puts on its title line: which model is about to run, and the
 * way to what that means. */
export function AiDialogStatus({
  feature,
  onLeave,
}: {
  feature: AiFeature;
  onLeave?: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <AiStatusPill feature={feature} compact onLeave={onLeave} />
      <AiDisclosureButton onLeave={onLeave} />
    </div>
  );
}
