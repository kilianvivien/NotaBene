/**
 * A `<select>` that is as wide as its widest option.
 *
 * The native control sizes itself to its content, which is exactly right — the
 * clipping this replaces came from capping that width in CSS and hoping the
 * labels stayed short. They do not: "Last modified" is 13 characters and
 * "Dernière modification" is 21, and the French build is the one a French
 * student sees. So nothing here constrains the width; the *caller* decides how
 * much room the control gets, and the control never promises to fit inside less
 * than its text needs.
 *
 * `appearance-none` plus our own chevron, because the platform's own arrow is
 * drawn inside the padding box and leaves the last glyph half-covered at small
 * sizes.
 */
import { ChevronsUpDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

interface GlassSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Required: a bare select in a toolbar has no visible label. */
  label: string;
  /** `plain` drops the border and background for use inside a dense header. */
  variant?: 'field' | 'plain';
  size?: 'sm' | 'md';
}

export function GlassSelect({
  label,
  variant = 'field',
  size = 'md',
  className,
  children,
  ...rest
}: GlassSelectProps) {
  return (
    <div className={cn('relative inline-flex min-w-0 items-center', className)}>
      <select
        aria-label={label}
        title={label}
        className={cn(
          'w-full min-w-0 appearance-none rounded-nb-xs bg-transparent',
          'text-nb-text-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]',
          size === 'sm' ? 'h-7 text-[12px]' : 'h-8 text-[13px]',
          // Room on the right for the chevron we draw ourselves.
          variant === 'field'
            ? 'border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] pl-2 pr-7'
            : 'pl-1 pr-5',
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronsUpDown
        size={size === 'sm' ? 11 : 12}
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-nb-text-3',
          variant === 'field' ? 'right-2' : 'right-0',
        )}
      />
    </div>
  );
}
