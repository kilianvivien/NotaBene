/**
 * The shape every dialog in NotaBene has.
 *
 * Two problems this exists to stop recurring, both visible in the export sheet
 * before it:
 *
 * 1. **The panel was one width and the form was another.** `ModalOverlay` fixed
 *    the panel at 680px while each dialog set its own `w-[460px]` inside it, so
 *    a four-row form sat in a panel with 220px of empty space along one edge.
 *    Here the size is a property of the dialog and the body fills it.
 * 2. **The footer floated.** Actions now sit on a divided footer, and a long
 *    body scrolls under it rather than pushing the buttons off screen.
 *
 * Rows inside the body come from `FieldRow`, which Settings uses too.
 */
import type { ReactNode } from 'react';
import { ModalOverlay } from './ModalOverlay';

/** Panel widths. `sm` is a single field, `md` a short form, `lg` anything with
 * a list or a preview in it. */
const WIDTHS = {
  sm: 'max-w-[420px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[680px]',
} as const;

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** One line under the title. Use it for the thing the user needs to know
   * before touching a control, not for a restatement of the title. */
  description?: string;
  size?: keyof typeof WIDTHS;
  /** Trailing element on the title line — an AI status pill, typically. */
  headerAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  headerAction,
  footer,
  children,
}: DialogProps) {
  return (
    <ModalOverlay open={open} onClose={onClose} label={title} className={WIDTHS[size]}>
      <div className="flex max-h-[80vh] flex-col">
        <header className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-tight">{title}</h2>
            {description && (
              <p className="mt-1 text-[12px] leading-snug text-nb-text-3">{description}</p>
            )}
          </div>
          {headerAction && <div className="shrink-0 pt-0.5">{headerAction}</div>}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--nb-divider)] px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </ModalOverlay>
  );
}
