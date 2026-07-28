import type { ComponentType } from 'react';
import { cn } from '@/lib/utils/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;
}

interface GlassSegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  label: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
}

export function GlassSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  iconOnly = false,
  disabled = false,
}: GlassSegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'glass-thin inline-flex gap-0.5 rounded-nb-sm p-0.5',
        'border-[0.5px] border-[var(--nb-glass-border)]',
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
            title={iconOnly ? option.label : undefined}
            aria-checked={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-7 rounded-[8px] px-3 text-[12px] font-medium',
              'inline-flex items-center justify-center gap-1.5',
              'transition-colors duration-[var(--nb-t-fast)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              value === option.value
                ? 'bg-[var(--nb-glass-strong)] text-nb-text shadow-sm'
                : 'text-nb-text-2 hover:text-nb-text',
            )}
          >
            {Icon && <Icon size={14} aria-hidden />}
            <span className={cn(iconOnly && 'sr-only')}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
