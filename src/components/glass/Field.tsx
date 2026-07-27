/**
 * Labelled rows, shared by dialogs and by Settings.
 *
 * The reason this is one component rather than the four near-identical
 * `SettingRow`s it replaces: they all used `justify-between`, which puts each
 * control's left edge wherever its own label happens to stop. A column of
 * selects under labels of different lengths then comes out ragged, and adding a
 * row in French moves the controls again. `FieldRow` puts every control in one
 * grid column instead, so their edges agree by construction and stay agreeing
 * when a translation gets longer.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export function FieldRow({
  label,
  hint,
  htmlFor,
  align = 'stretch',
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  /** `stretch` makes the control fill the column (selects, inputs); `end`
   * parks a naturally small control — a checkbox, a switch — on the right. */
  align?: 'stretch' | 'end';
  children: ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,240px)] items-center gap-4 py-1.5">
      <Label htmlFor={htmlFor} className="min-w-0">
        <span className="block text-[13px] leading-snug">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[11px] leading-snug text-nb-text-3">
            {hint}
          </span>
        )}
      </Label>
      <div
        className={cn(
          'flex min-w-0 items-center',
          align === 'end' ? 'justify-end' : '[&>*]:w-full',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** A titled block of rows. */
export function FieldSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="py-1">
      {title && (
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
          {title}
        </h3>
      )}
      {description && (
        <p className="mt-1 text-[11px] leading-snug text-nb-text-3">{description}</p>
      )}
      <div className={cn(title || description ? 'mt-1.5' : undefined)}>{children}</div>
    </section>
  );
}

/** A status line under a form — a count, an error, a "done". Kept out of the
 * footer so it cannot push the buttons around as it appears. */
export function FieldNote({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'danger';
}) {
  return (
    <p
      className={cn(
        'mt-2 text-[12px] leading-snug',
        tone === 'danger' ? 'text-[var(--nb-danger)]' : 'text-nb-text-3',
      )}
    >
      {children}
    </p>
  );
}

export function FieldToggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-[var(--nb-t-fast)]',
        'disabled:pointer-events-none disabled:opacity-40',
        checked ? 'bg-[var(--nb-accent)]' : 'bg-[var(--nb-active)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[2px] size-[18px] rounded-full bg-white shadow-sm',
          'transition-[left] duration-[var(--nb-t-fast)]',
          checked ? 'left-[18px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}
