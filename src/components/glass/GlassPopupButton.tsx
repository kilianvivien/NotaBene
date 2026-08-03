/**
 * A pop-up button: the value you have, and a menu of the ones you do not.
 *
 * The counterpart to `GlassSegmentedControl`, and the right control whenever
 * the labels are longer than the space. A segmented control has to render every
 * option at once, so in a 280px inspector three French scope labels came out as
 * "Cette … / Ce co… / Toute…" — three ellipses where there should be three
 * words. A pop-up shows one label and gives the rest to a menu, which is free to
 * be wider than the pane that opened it.
 *
 * It is deliberately borderless. This sits above content rather than inside a
 * form, and a bordered control there reads as a field waiting to be filled in.
 * The chevron is the affordance; hover and the open state supply the rest.
 */
import { useRef, useState } from 'react';
import { ChevronsUpDown, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ContextMenu, type ContextPoint } from './ContextMenu';

export interface PopupOption<T extends string> {
  value: T;
  label: string;
  /** Unavailable for this particular thing — "this course", with the note in
   * the inbox. `title` is where the row says why. */
  disabled?: boolean;
  title?: string;
}

export function GlassPopupButton<T extends string>({
  label,
  value,
  options,
  onChange,
  icon: Icon,
  disabled = false,
  className,
}: {
  /** Names the axis, not the value — "Search", "Answer sources". It is the
   * accessible name of the trigger and the header of the menu. */
  label: string;
  value: T;
  options: PopupOption<T>[];
  onChange(value: T): void;
  /** Shown before the label. Pass a glyph that follows the value and it doubles
   * as a second read of the current state. */
  icon?: LucideIcon;
  disabled?: boolean;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [point, setPoint] = useState<ContextPoint | null>(null);
  const current = options.find((option) => option.value === value);

  function toggle(): void {
    if (point) {
      setPoint(null);
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPoint({ x: rect.left, y: rect.bottom + 4 });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={point !== null}
        title={current ? `${label} · ${current.label}` : label}
        disabled={disabled}
        // The menu dismisses itself on any `pointerdown` outside it. Without
        // this the second click on an open trigger would close it on the way
        // down and reopen it on the way up.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={toggle}
        className={cn(
          'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-nb-xs px-1.5',
          'text-[12px] font-medium text-nb-text-2',
          'transition-colors duration-[var(--nb-t-fast)]',
          'hover:bg-[var(--nb-hover)] hover:text-nb-text',
          'disabled:pointer-events-none disabled:opacity-50',
          point && 'bg-[var(--nb-hover)] text-nb-text',
          className,
        )}
      >
        {Icon && <Icon size={13} className="shrink-0 text-nb-text-3" aria-hidden />}
        <span className="truncate">{current?.label ?? ''}</span>
        <ChevronsUpDown size={11} className="shrink-0 text-nb-text-3" aria-hidden />
      </button>

      {point && (
        <ContextMenu
          point={point}
          header={label}
          onClose={() => {
            setPoint(null);
            trigger.current?.focus();
          }}
          items={options.map((option) => ({
            id: option.value,
            label: option.label,
            title: option.title,
            disabled: option.disabled,
            selected: option.value === value,
            onSelect: () => onChange(option.value),
          }))}
        />
      )}
    </>
  );
}
