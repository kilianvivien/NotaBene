/**
 * Text size and column width, adjustable without leaving the page.
 *
 * The equivalent of a browser reading mode's type controls. Both values are
 * ordinary settings — they persist, and they are also in Settings → Editor —
 * but a reader who finds the column too wide halfway through a lecture should
 * not have to open a modal over the note to fix it.
 *
 * It rides the same reveal as the bars: reach for the top edge and the controls
 * come with them. Nothing new to learn, and nothing on the page while writing.
 */
import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import type { AppSettings } from '@/lib/adapters';
import { EDITOR_FONT_SIZES, EDITOR_MEASURES, MEASURE_STEP } from './readingScale';

export function ReadingControls() {
  const { t } = useTranslation();
  const focusMode = useUiStore((state) => state.focusMode);
  const fontSize = useSettingsStore((state) => state.settings.editorFontSize);
  const measure = useSettingsStore((state) => state.settings.editorMeasure);
  const update = useSettingsStore((state) => state.update);

  if (!focusMode) return null;

  const set = (patch: Partial<AppSettings>) => void update(patch);
  const clamp = (value: number, { min, max }: { min: number; max: number }) =>
    Math.min(Math.max(value, min), max);

  return (
    <div className="nb-reading-controls" role="group" aria-label={t('reading.controls')}>
      <Stepper
        label={t('reading.textSize')}
        value={`${fontSize}`}
        outLabel={t('reading.textSmaller')}
        inLabel={t('reading.textLarger')}
        atMin={fontSize <= EDITOR_FONT_SIZES.min}
        atMax={fontSize >= EDITOR_FONT_SIZES.max}
        onOut={() => set({ editorFontSize: clamp(fontSize - 1, EDITOR_FONT_SIZES) })}
        onIn={() => set({ editorFontSize: clamp(fontSize + 1, EDITOR_FONT_SIZES) })}
      />
      <span className="nb-reading-divider" aria-hidden />
      <Stepper
        label={t('reading.width')}
        value={`${measure}`}
        outLabel={t('reading.widthNarrower')}
        inLabel={t('reading.widthWider')}
        atMin={measure <= EDITOR_MEASURES.min}
        atMax={measure >= EDITOR_MEASURES.max}
        onOut={() =>
          set({ editorMeasure: clamp(measure - MEASURE_STEP, EDITOR_MEASURES) })
        }
        onIn={() =>
          set({ editorMeasure: clamp(measure + MEASURE_STEP, EDITOR_MEASURES) })
        }
      />
    </div>
  );
}

interface StepperProps {
  label: string;
  value: string;
  outLabel: string;
  inLabel: string;
  atMin: boolean;
  atMax: boolean;
  onOut(): void;
  onIn(): void;
}

function Stepper({
  label,
  value,
  outLabel,
  inLabel,
  atMin,
  atMax,
  onOut,
  onIn,
}: StepperProps) {
  return (
    <div className="nb-reading-stepper">
      <button
        type="button"
        aria-label={outLabel}
        title={outLabel}
        disabled={atMin}
        onClick={onOut}
      >
        <Minus size={13} aria-hidden />
      </button>
      {/* The number is the readout, the group's name is the label — saying
          "Text size 16" on every press would be noise in a screen reader. */}
      <span aria-hidden title={label}>
        {value}
      </span>
      <button
        type="button"
        aria-label={inLabel}
        title={inLabel}
        disabled={atMax}
        onClick={onIn}
      >
        <Plus size={13} aria-hidden />
      </button>
    </div>
  );
}
