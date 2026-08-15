/**
 * A date and time, with the shortcuts a student actually uses.
 *
 * Backed by a native `datetime-local` input rather than a hand-built calendar:
 * the OS picker already speaks the user's locale and their keyboard, and a
 * bespoke one would be a second thing to localise and to make accessible.
 *
 * The quick chips exist because "tomorrow" is how a deadline is usually
 * expressed, and the native control has no notion of it.
 */
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils/cn';

/**
 * `datetime-local` speaks local wall-clock time with no zone; the library
 * stores ISO instants. These two functions are the whole conversion, and they
 * must stay inverses of each other.
 */
function toInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function fromInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Days from today at a fixed hour, which is what "tomorrow" means for a due date. */
function relativeDay(days: number, hour = 9): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

export function GlassDateField({
  label,
  value,
  onChange,
  id,
  disabled = false,
  showQuickChips = true,
}: {
  label: string;
  value: string | null;
  onChange(next: string | null): void;
  id?: string;
  disabled?: boolean;
  showQuickChips?: boolean;
}) {
  const { t } = useTranslation();

  const chips: { labelKey: string; days: number }[] = [
    { labelKey: 'tasks.today', days: 0 },
    { labelKey: 'tasks.tomorrow', days: 1 },
    { labelKey: 'tasks.nextWeek', days: 7 },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          id={id}
          type="datetime-local"
          aria-label={label}
          disabled={disabled}
          value={toInputValue(value)}
          onChange={(event) => onChange(fromInputValue(event.target.value))}
          className={cn(
            'min-w-0 flex-1 rounded-nb-sm border border-[var(--nb-control-border)]',
            'bg-[var(--nb-control-surface)] px-2 py-1 text-[13px] text-nb-text',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        />
        {value && !disabled && (
          <button
            type="button"
            aria-label={t('tasks.clearDate')}
            onClick={() => onChange(null)}
            className="flex size-6 shrink-0 items-center justify-center rounded-nb-xs text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </div>
      {showQuickChips && !disabled && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <button
              key={chip.labelKey}
              type="button"
              onClick={() => onChange(relativeDay(chip.days))}
              className="rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-0.5 text-[11.5px] text-nb-text-2 hover:bg-[var(--nb-hover)]"
            >
              {t(chip.labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
