import { cn } from '@/lib/utils/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface GlassSegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  label: string;
  className?: string;
}

export function GlassSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
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
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 rounded-[8px] px-3 text-[12px] font-medium',
            'transition-colors duration-[var(--nb-t-fast)]',
            value === option.value
              ? 'bg-[var(--nb-glass-strong)] text-nb-text shadow-sm'
              : 'text-nb-text-2 hover:text-nb-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
