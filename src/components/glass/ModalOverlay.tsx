import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { GlassPanel } from './GlassPanel';

/** Must match `--nb-t-fast`, which is how long the exit animation runs. The
 * panel has to stay mounted for exactly as long as it is still on screen. */
const EXIT_MS = 160;

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

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

  /**
   * Escape and the focus trap read the *current* `onClose`, but the effect
   * below must not re-run when its identity changes.
   *
   * A caller that closes over anything — `DefineDialog`'s `close`, which
   * cancels the run first — hands us a new function on every render. Keying the
   * effect on it made the cleanup fire on every render too, and that cleanup
   * restores focus to whatever was focused when the modal opened. Opened from
   * the editor, that is ProseMirror: focusing it dispatches a selection
   * transaction, the editor re-renders on transactions, the dialog re-renders
   * with it, and the effect runs again — an update loop React ends with
   * "maximum update depth exceeded".
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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
    // `mounted` and not just `open`: the panel is rendered by the *next* commit,
    // so on the render where `open` first turns true `overlay.current` is still
    // null and there is nothing here to focus. Keying on `mounted` runs this
    // once the panel is in the DOM, which is the only moment the query below
    // can find anything.
    if (!open || !mounted) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Synchronously, now that the panel is in the DOM. It used to wait for an
    // animation frame, which does not run at all in a hidden or background tab
    // — the dialog opened there with focus still in whatever the student was
    // typing in, so their next keystrokes went into the note.
    //
    // "First focusable" is the wrong default when the first thing in the DOM
    // is a status readout. Every AI dialog opened with its provider pill
    // focused, so Return went to Settings instead of to what the dialog is
    // for. A region can decline the honour with `data-modal-focus="skip"`,
    // and anything that wants it can claim it outright.
    const claimed = overlay.current?.querySelector<HTMLElement>('[data-autofocus]');
    const first = [
      ...(overlay.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ].find((element) => !element.closest('[data-modal-focus="skip"]'));
    (
      claimed ??
      first ??
      overlay.current?.querySelector<HTMLElement>('[role="dialog"]')
    )?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      // The trap keeps every focusable in the cycle, including the ones the
      // opening focus skips: declining to be focused *first* is not the same as
      // being unreachable.
      const focusable = [
        ...(overlay.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
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
  }, [open, mounted]);

  if (!mounted) return null;

  return (
    <div
      ref={overlay}
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-5 pb-5 pt-[12vh]',
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
          'w-full max-w-[680px] shrink-0 overflow-hidden',
          closing && 'panel-anim-out',
          className,
        )}
      >
        {children}
      </GlassPanel>
    </div>
  );
}
