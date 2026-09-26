import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface GlassIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control is invisible to VoiceOver without it. */
  label: string;
  /** Makes the button a toggle, announced as pressed or not. Leave it out for
   * a plain action — "New course" is not a switch, and saying "not pressed"
   * about it misdescribes it to VoiceOver. */
  active?: boolean;
  children: ReactNode;
}

export function GlassIconButton({
  label,
  active,
  className,
  children,
  ...rest
}: GlassIconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-nb-sm',
        'text-nb-text-2 transition-colors duration-[var(--nb-t-fast)]',
        'hover:bg-[var(--nb-hover)] hover:text-nb-text',
        'active:bg-[var(--nb-active)] disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
