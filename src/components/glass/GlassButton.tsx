import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'accent' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

const VARIANTS: Record<NonNullable<GlassButtonProps['variant']>, string> = {
  default: 'glass hover:brightness-105',
  accent: 'text-[var(--nb-text-on-accent)] bg-[var(--nb-accent)] hover:bg-[var(--nb-accent-strong)]',
  ghost: 'bg-transparent hover:bg-[var(--nb-hover)]',
  danger: 'text-white bg-[var(--nb-danger)] hover:brightness-110',
};

export function GlassButton({
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: GlassButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-nb-sm font-medium',
        'transition-[background,filter,transform] duration-[var(--nb-t-fast)]',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-9 px-3.5 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
