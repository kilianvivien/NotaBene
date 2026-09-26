/**
 * A choice between a few things that each need a sentence to explain.
 *
 * The AI dialogs kept asking questions whose options were not self-evident —
 * "Light cleanup" or "Full rewrite", a mind map or a diagram, a narrated
 * episode or two speakers — and answered them with segmented controls that
 * truncated in French and dropdowns that hid the explanation until after the
 * choice. Here every option is a card that says what it does, and the chosen
 * one is unmistakable.
 *
 * It is one radio group whatever it looks like: the cards are `role="radio"`,
 * named by their title and described by their sentence, only the chosen card
 * is in the tab order, and the arrow keys move the choice — the keyboard
 * contract of a native radio group, which is what a screen reader announces.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** A short caution beside the title — "Changes wording". */
  badge?: string;
  /** A small illustration across the top of the card. Drawn in
   * `currentColor`, which follows the card's chosen state. */
  picture?: ReactNode;
  /** Anything else the card should carry under its description. */
  detail?: ReactNode;
  disabled?: boolean;
  /** Take the whole row in a multi-column group — an odd card out, or the
   * "none of these" option that belongs after the rest. */
  wide?: boolean;
}

export interface ChoiceSection<T extends string> {
  label?: string;
  options: ChoiceOption<T>[];
  /** One card per row, or two side by side from the small breakpoint up. */
  columns?: 1 | 2 | 3;
}

export function ChoiceGroup<T extends string>({
  label,
  value,
  onChange,
  options,
  sections,
  columns = 2,
  disabled = false,
  className,
}: {
  /** Names the question, for assistive technology. */
  label: string;
  value: T;
  onChange(value: T): void;
  /** A single unlabelled section. */
  options?: ChoiceOption<T>[];
  /** Or several, headed, still one group for the keyboard. */
  sections?: ChoiceSection<T>[];
  columns?: 1 | 2 | 3;
  disabled?: boolean;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const prefix = `nb-choice${useId().replace(/:/g, '')}`;
  const all: ChoiceSection<T>[] = sections ?? [{ options: options ?? [], columns }];
  const enabled = all
    .flatMap((section) => section.options)
    .filter((option) => !option.disabled && !disabled)
    .map((option) => option.value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!step || !enabled.length) return;
    event.preventDefault();
    const index = enabled.indexOf(value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (next === undefined) return;
    onChange(next);
    group.current?.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('flex flex-col gap-4', className)}
    >
      {all.map((section, sectionIndex) => (
        <section key={section.label ?? sectionIndex}>
          {section.label && (
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
              {section.label}
            </h3>
          )}
          <div
            className={cn(
              'grid gap-2',
              (section.columns ?? columns) === 2 && 'sm:grid-cols-2',
              (section.columns ?? columns) === 3 && 'sm:grid-cols-3',
            )}
          >
            {section.options.map((option) => (
              <ChoiceCard
                key={option.value}
                id={`${prefix}-${option.value}`}
                option={option}
                selected={option.value === value}
                // Keep something focusable if the chosen card is disabled.
                focusable={
                  option.value === value ||
                  (!enabled.includes(value) && option.value === enabled[0])
                }
                disabled={disabled || option.disabled === true}
                onChoose={() => onChange(option.value)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ChoiceCard<T extends string>({
  id,
  option,
  selected,
  focusable,
  disabled,
  onChoose,
}: {
  id: string;
  option: ChoiceOption<T>;
  selected: boolean;
  focusable: boolean;
  disabled: boolean;
  onChoose(): void;
}) {
  const Icon = option.icon;
  const title = (
    <span className="flex items-center gap-2">
      {option.picture && Icon && (
        <Icon
          size={14}
          aria-hidden
          className={selected ? 'text-[var(--nb-accent)]' : 'text-nb-text-2'}
        />
      )}
      <span id={`${id}-title`} className="text-[13px] font-semibold text-nb-text">
        {option.title}
      </span>
      {option.badge && (
        <span className="rounded-full bg-[color-mix(in_srgb,var(--nb-warn)_14%,transparent)] px-1.5 py-px text-[10px] font-medium text-[var(--nb-warn)]">
          {option.badge}
        </span>
      )}
    </span>
  );
  const text = (
    <>
      {title}
      {option.description && (
        <span
          id={`${id}-description`}
          className={cn(
            'mt-0.5 block leading-snug',
            option.picture
              ? 'text-[12px] text-nb-text-2'
              : 'text-[11.5px] text-nb-text-3',
          )}
        >
          {option.description}
        </span>
      )}
      {option.detail}
    </>
  );

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-labelledby={`${id}-title`}
      aria-describedby={option.description ? `${id}-description` : undefined}
      data-choice={option.value}
      tabIndex={focusable ? 0 : -1}
      disabled={disabled}
      onClick={onChoose}
      className={cn(
        'w-full rounded-nb-md border text-left',
        option.wide && 'sm:col-span-full',
        'transition-[border-color,background-color,box-shadow] duration-[var(--nb-t-fast)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        option.picture
          ? 'flex flex-col overflow-hidden'
          : 'flex items-start gap-3 px-3 py-2.5',
        selected
          ? 'border-[var(--nb-accent)] shadow-[0_0_0_1px_var(--nb-accent)]'
          : 'border-[var(--nb-divider)] enabled:hover:border-[var(--nb-divider-strong)]',
        !option.picture &&
          (selected
            ? 'bg-[var(--nb-accent-soft)]'
            : 'bg-[var(--nb-control-surface)] enabled:hover:bg-[var(--nb-hover)]'),
      )}
    >
      {option.picture ? (
        <>
          <span
            aria-hidden
            className={cn(
              'grid h-[112px] place-items-center border-b',
              selected
                ? 'border-[color-mix(in_srgb,var(--nb-accent)_35%,var(--nb-divider))] bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                : 'border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] text-nb-text-3',
            )}
          >
            {option.picture}
          </span>
          <span className="flex flex-col px-3.5 py-3">{text}</span>
        </>
      ) : (
        <>
          {Icon && (
            <span
              className={cn(
                'mt-0.5 grid size-7 shrink-0 place-items-center rounded-nb-sm',
                selected
                  ? 'bg-[var(--nb-accent)] text-[var(--nb-text-on-accent)]'
                  : 'border border-[var(--nb-divider)] bg-[var(--nb-hover)] text-nb-text-2',
              )}
            >
              <Icon size={14} aria-hidden />
            </span>
          )}
          <span className="min-w-0 flex-1">{text}</span>
        </>
      )}
    </button>
  );
}
