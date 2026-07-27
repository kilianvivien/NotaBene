import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** `strong` for surfaces that sit above others (modals, popovers); `thin`
   * for large backdrops where full glass would be too heavy. */
  variant?: 'default' | 'strong' | 'thin';
  animate?: boolean;
  children?: ReactNode;
}

export function GlassPanel({
  variant = 'default',
  animate = false,
  className,
  children,
  ...rest
}: GlassPanelProps) {
  return (
    <div
      className={cn(
        'glass',
        variant === 'strong' && 'glass-strong',
        variant === 'thin' && 'glass-thin',
        animate && 'panel-anim',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
