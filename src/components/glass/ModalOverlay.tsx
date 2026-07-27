import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { GlassPanel } from './GlassPanel';

interface ModalOverlayProps {
  open: boolean;
  onClose(): void;
  label: string;
  children: ReactNode;
  className?: string;
}

export function ModalOverlay({
  open,
  onClose,
  label,
  children,
  className,
}: ModalOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      style={{ background: 'var(--nb-scrim)' }}
      onMouseDown={(event) => {
        // Only a click on the scrim itself dismisses — not a drag that ended
        // out here after starting inside the panel.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <GlassPanel
        variant="strong"
        animate
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn('w-[min(680px,90vw)] overflow-hidden', className)}
      >
        {children}
      </GlassPanel>
    </div>
  );
}
