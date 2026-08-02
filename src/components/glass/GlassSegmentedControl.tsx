import type { ComponentType } from 'react';
import { cn } from '@/lib/utils/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
  /** Unavailable for this particular thing, while the rest of the control
   * works — "this course" with the note in the inbox. */
  disabled?: boolean;
  /** Overrides the tooltip, which is where a disabled option says why. */
  title?: string;
}

interface GlassSegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  label: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
  /**
   * Stretch to the caller's width and split it equally between the segments.
   *
   * Without this the control is as wide as its labels, which is fine in a
   * dialog and wrong in a 280px inspector: "Note + connaissances de l'IA" is
   * three times "Note only", and the intrinsic width simply left the pane.
   * Filled segments share the room and ellipsise, so a long translation
   * shortens instead of escaping.
   */
  fill?: boolean;
}

export function GlassSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  iconOnly = false,
  disabled = false,
  fill = false,
}: GlassSegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'glass-thin gap-0.5 rounded-nb-sm p-0.5',
        'border-[0.5px] border-[var(--nb-glass-border)]',
        fill ? 'flex w-full' : 'inline-flex',
        className,
      )}
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-label={iconOnly ? option.label : undefined}
            // Ellipsised text needs its full label somewhere reachable.
            title={option.title ?? (iconOnly || fill ? option.label : undefined)}
            aria-checked={value === option.value}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-7 rounded-[8px] text-[12px] font-medium leading-tight',
              'inline-flex items-center justify-center gap-1.5',
              'transition-colors duration-[var(--nb-t-fast)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              fill ? 'min-w-0 flex-1 px-2' : 'px-3',
              value === option.value
                ? 'bg-[var(--nb-glass-strong)] text-nb-text shadow-sm'
                : 'text-nb-text-2 hover:text-nb-text',
            )}
          >
            {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
            <span className={cn(iconOnly ? 'sr-only' : 'truncate')}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
