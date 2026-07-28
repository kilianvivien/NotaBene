import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { GlassPanel } from './GlassPanel';

/** Must match `--nb-t-fast`, which is how long the exit animation runs. The
 * panel has to stay mounted for exactly as long as it is still on screen. */
const EXIT_MS = 160;

interface ModalOverlayProps {
  open: boolean;
  onClose(): void;
  label: string;
  children: ReactNode;
  className?: string;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function ModalOverlay({
  open,
  onClose,
  label,
  children,
  className,
}: ModalOverlayProps) {
  // Closing is a state, not an event: the panel outlives `open` by one
  // animation, so it can be seen leaving rather than simply ceasing to exist.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;

    // Nobody who asked for less motion should sit through an animation they
    // are not going to see.
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }

    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => {
      const first = overlay.current?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? overlay.current?.querySelector<HTMLElement>('[role="dialog"]'))?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(overlay.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        last?.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === last) {
        first?.focus();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      ref={overlay}
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center pt-[12vh]',
        closing ? 'scrim-anim-out' : 'scrim-anim',
      )}
      style={{ background: 'var(--nb-scrim)' }}
      onMouseDown={(event) => {
        // A panel already on its way out should not answer clicks; the one
        // that matters is whatever is underneath it.
        if (closing) return;
        // Only a click on the scrim itself dismisses — not a drag that ended
        // out here after starting inside the panel.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <GlassPanel
        variant="strong"
        animate={!closing}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          'w-[min(680px,90vw)] overflow-hidden',
          closing && 'panel-anim-out',
          className,
        )}
      >
        {children}
      </GlassPanel>
    </div>
  );
}
