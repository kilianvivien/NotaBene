/**
 * Text size and column width, adjustable without leaving the page.
 *
 * The equivalent of a browser reading mode's type controls, and deliberately
 * the same shape: four glyphs and no readouts. A number beside each pair would
 * be one more thing on a page whose whole purpose is having nothing on it, and
 * it would be reporting what the reader can already see happen. The exact
 * values live in Settings → Editor for anyone who wants them.
 *
 * It rides the same reveal as the bars: reach for the top edge and the controls
 * come with them. Nothing new to learn, and nothing on the page while writing.
 */
import { AArrowDown, AArrowUp, ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import type { AppSettings } from '@/lib/adapters';
import { EDITOR_FONT_SIZES, EDITOR_MEASURES, MEASURE_STEP } from './readingScale';

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(Math.max(value, min), max);
}

export function ReadingControls() {
  const { t } = useTranslation();
  const focusMode = useUiStore((state) => state.focusMode);
  const fontSize = useSettingsStore((state) => state.settings.editorFontSize);
  const measure = useSettingsStore((state) => state.settings.editorMeasure);
  const update = useSettingsStore((state) => state.update);

  if (!focusMode) return null;

  const set = (patch: Partial<AppSettings>) => void update(patch);

  return (
    <div className="nb-reading-controls" role="group" aria-label={t('reading.controls')}>
      <Step
        label={t('reading.textSmaller')}
        icon={<AArrowDown size={15} aria-hidden />}
        disabled={fontSize <= EDITOR_FONT_SIZES.min}
        onClick={() => set({ editorFontSize: clamp(fontSize - 1, EDITOR_FONT_SIZES) })}
      />
      <Step
        label={t('reading.textLarger')}
        icon={<AArrowUp size={15} aria-hidden />}
        disabled={fontSize >= EDITOR_FONT_SIZES.max}
        onClick={() => set({ editorFontSize: clamp(fontSize + 1, EDITOR_FONT_SIZES) })}
      />
      {/* Space, not a rule: two pairs read as two pairs on spacing alone, and
          a divider is a line drawn on a page that wants none. */}
      <span className="nb-reading-gap" aria-hidden />
      <Step
        label={t('reading.widthNarrower')}
        icon={<ChevronsRightLeft size={15} aria-hidden />}
        disabled={measure <= EDITOR_MEASURES.min}
        onClick={() =>
          set({ editorMeasure: clamp(measure - MEASURE_STEP, EDITOR_MEASURES) })
        }
      />
      <Step
        label={t('reading.widthWider')}
        icon={<ChevronsLeftRight size={15} aria-hidden />}
        disabled={measure >= EDITOR_MEASURES.max}
        onClick={() =>
          set({ editorMeasure: clamp(measure + MEASURE_STEP, EDITOR_MEASURES) })
        }
      />
    </div>
  );
}

interface StepProps {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick(): void;
}

function Step({ label, icon, disabled, onClick }: StepProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
