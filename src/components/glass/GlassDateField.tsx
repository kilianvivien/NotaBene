/**
 * A date and time, chosen from a calendar rather than typed into a mask.
 *
 * This replaced a native `datetime-local`. That input is one line of code and
 * three problems: Chromium renders `mm/dd/yyyy, --:-- --` whatever the locale,
 * its popup belongs to the browser rather than to this app, and an empty field
 * shows a mask instead of saying what it is for. A deadline is worth a control
 * you can answer in one click.
 *
 * The popover is portalled to `document.body` and positioned from the trigger's
 * rect, for the same reason `MindMapViewer` is: an absolutely-positioned panel
 * inside `GlassScrollArea` is laid out against the scroller, not the window.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  addMonths,
  atTime,
  isSameDay,
  monthGrid,
  startOfDay,
  weekdayLabels,
} from '@/lib/utils/calendar';
import { cn } from '@/lib/utils/cn';

const POPOVER_WIDTH = 268;
const POPOVER_HEIGHT = 372;

/** Where a newly picked day lands when no time has been chosen yet. */
const DEFAULT_HOUR = 9;

function formatValue(iso: string, locale: string): string {
  const date = new Date(iso);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    ...(midnight ? {} : { hour: 'numeric', minute: '2-digit' }),
  });
}

/** `HH:MM` for the time input, from an instant. */
function timeValue(iso: string | null): string {
  if (!iso) return `${String(DEFAULT_HOUR).padStart(2, '0')}:00`;
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [month, setMonth] = useState(() => startOfDay(value ? new Date(value) : new Date()));

  useEffect(() => {
    if (open) setMonth(startOfDay(value ? new Date(value) : new Date()));
  }, [open, value]);

  // Measured after paint, so the flip decision uses the real viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const below = box.bottom + 6;
    const flip = below + POPOVER_HEIGHT > window.innerHeight;
    setAnchor({
      top: flip ? Math.max(8, box.top - POPOVER_HEIGHT - 6) : below,
      left: Math.min(box.left, Math.max(8, window.innerWidth - POPOVER_WIDTH - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);

  const selected = value ? new Date(value) : null;
  const today = startOfDay(new Date());
  const [hours, minutes] = timeValue(value).split(':').map(Number);

  function choose(day: Date): void {
    onChange(atTime(day, hours ?? DEFAULT_HOUR, minutes ?? 0));
    setOpen(false);
    trigger.current?.focus();
  }

  const chips: { labelKey: string; days: number }[] = [
    { labelKey: 'tasks.today', days: 0 },
    { labelKey: 'tasks.tomorrow', days: 1 },
    { labelKey: 'tasks.nextWeek', days: 7 },
  ];

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        ref={trigger}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-nb-sm border px-2 py-1 text-left text-[13px]',
          'border-[var(--nb-control-border)] bg-[var(--nb-control-surface)]',
          'transition-colors duration-[var(--nb-t-fast)] hover:border-[var(--nb-accent)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
      >
        <CalendarDays size={13} aria-hidden className="shrink-0 text-nb-text-3" />
        <span className={cn('truncate', !value && 'text-nb-text-3')}>
          {value ? formatValue(value, locale) : t('tasks.noDate')}
        </span>
      </button>

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

      {open &&
        anchor &&
        createPortal(
          <>
            {/* Catches the click that dismisses, so the popover does not have
                to guess at what counts as "outside". */}
            <div
              className="fixed inset-0 z-[60]"
              onMouseDown={() => setOpen(false)}
              aria-hidden
            />
            <div
              role="dialog"
              aria-label={label}
              style={{ top: anchor.top, left: anchor.left, width: POPOVER_WIDTH }}
              className="glass glass-strong fixed z-[61] rounded-nb-md p-2 shadow-[var(--nb-shadow-lg)]"
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <button
                  type="button"
                  aria-label={t('tasks.previousMonth')}
                  onClick={() => setMonth((current) => addMonths(current, -1))}
                  className="flex size-6 items-center justify-center rounded-nb-xs text-nb-text-2 hover:bg-[var(--nb-hover)]"
                >
                  <ChevronLeft size={14} aria-hidden />
                </button>
                <span className="text-[12.5px] font-medium">
                  {month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
                </span>
                <button
                  type="button"
                  aria-label={t('tasks.nextMonth')}
                  onClick={() => setMonth((current) => addMonths(current, 1))}
                  className="flex size-6 items-center justify-center rounded-nb-xs text-nb-text-2 hover:bg-[var(--nb-hover)]"
                >
                  <ChevronRight size={14} aria-hidden />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-0.5">
                {weekdayLabels(locale).map((day) => (
                  <span
                    key={day}
                    className="pb-1 text-center text-[10.5px] font-medium uppercase text-nb-text-3"
                  >
                    {day.slice(0, 2)}
                  </span>
                ))}
                {monthGrid(month, locale)
                  .flat()
                  .map((day) => {
                    const outside = day.getMonth() !== month.getMonth();
                    const isToday = isSameDay(day, today);
                    const isSelected = selected !== null && isSameDay(day, selected);
                    return (
                      <button
                        key={day.toISOString()}
                        type="button"
                        aria-current={isToday ? 'date' : undefined}
                        aria-pressed={isSelected}
                        onClick={() => choose(day)}
                        className={cn(
                          'flex h-7 items-center justify-center rounded-nb-xs text-[12.5px] tabular-nums',
                          'transition-colors duration-[var(--nb-t-fast)]',
                          isSelected
                            ? 'bg-[var(--nb-accent)] font-medium text-[var(--nb-text-on-accent)]'
                            : outside
                              ? 'text-nb-text-3 opacity-55 hover:bg-[var(--nb-hover)]'
                              : 'text-nb-text hover:bg-[var(--nb-hover)]',
                          // Today keeps a ring rather than a fill, so it never
                          // reads as the selected day when it is not.
                          isToday &&
                            !isSelected &&
                            'ring-1 ring-inset ring-[var(--nb-accent)] text-[var(--nb-accent)]',
                        )}
                      >
                        {day.getDate()}
                      </button>
                    );
                  })}
              </div>

              <div className="mt-2 flex items-center gap-1.5 border-t border-[var(--nb-divider)] pt-2">
                <label className="flex items-center gap-1.5 text-[11.5px] text-nb-text-3">
                  {t('tasks.atTime')}
                  <input
                    type="time"
                    value={timeValue(value)}
                    onChange={(event) => {
                      const [hour, minute] = event.target.value.split(':').map(Number);
                      const day = selected ?? today;
                      onChange(atTime(day, hour ?? DEFAULT_HOUR, minute ?? 0));
                    }}
                    className="rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-1.5 py-0.5 text-[12px] text-nb-text"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="ml-auto rounded-nb-xs px-2 py-1 text-[11.5px] text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-nb-text"
                >
                  {t('tasks.clearDate')}
                </button>
              </div>

              {showQuickChips && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {chips.map((chip) => (
                    <button
                      key={chip.labelKey}
                      type="button"
                      onClick={() => {
                        const day = new Date();
                        day.setDate(day.getDate() + chip.days);
                        choose(startOfDay(day));
                      }}
                      className="rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-0.5 text-[11.5px] text-nb-text-2 hover:bg-[var(--nb-hover)]"
                    >
                      {t(chip.labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
