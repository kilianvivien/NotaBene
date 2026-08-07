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
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,280px)] items-center gap-5 py-2">
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
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title?: string;
  description?: string;
  /** Turns the title into a disclosure. The description stays put either way —
   * it is the label for what is folded away, so hiding it too would leave a
   * heading that says nothing about what opening it gets you. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const folded = collapsible && !open;

  return (
    <section>
      {/* The button goes inside the heading, never the other way round: a
          heading nested in a button is not phrasing content, and the browser
          drops it from the accessibility tree — the section would lose the
          landmark a screen reader navigates by. */}
      {title && (
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-nb-text-3">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              /* `uppercase` again, not only on the h3: the form-control reset
                 gives buttons their own `text-transform`, so it does not
                 inherit the way the rest of the heading's type does. */
              className="-ml-[3px] flex items-center gap-1 text-left uppercase tracking-[0.07em] hover:text-nb-text-2"
            >
              <ChevronRight
                size={12}
                aria-hidden
                className={cn(
                  'shrink-0 transition-transform duration-[var(--nb-t-fast)]',
                  open && 'rotate-90',
                )}
              />
              {title}
            </button>
          ) : (
            title
          )}
        </h3>
      )}
      {description && (
        <p className="mt-1 max-w-[62ch] text-[11.5px] leading-snug text-nb-text-3">
          {description}
        </p>
      )}
      {!folded && (
        <div className={cn(title || description ? 'mt-2' : undefined)}>{children}</div>
      )}
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
  /** `notice` is for a limit of the platform rather than a fault of the user's
   * — "this needs the desktop app". Those were coming out in danger red, which
   * spends the one colour that should mean "something went wrong". */
  tone?: 'muted' | 'notice' | 'danger';
}) {
  return (
    <p
      className={cn(
        'mt-2 text-[12px] leading-snug',
        tone === 'danger' && 'text-[var(--nb-danger)]',
        tone === 'notice' &&
          'rounded-nb-xs bg-[var(--nb-inset-surface)] px-2.5 py-1.5 text-nb-text-2',
        tone === 'muted' && 'text-nb-text-3',
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
